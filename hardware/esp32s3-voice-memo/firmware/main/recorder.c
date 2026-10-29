/* Single PCM source: committed SD bytes are copied into an absolute-offset ring.
 * Congestion can discard a live prefix, never renumber/relabel source bytes. */
#include "lj.h"
#include "pcm_fifo.h"
#include <fcntl.h>
#include <inttypes.h>
#include <string.h>
#include <unistd.h>
#include "esp_heap_caps.h"
#include "esp_random.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "mbedtls/sha256.h"
#include "freertos/task.h"

static SemaphoreHandle_t lock;
static lj_capture_t cap;
static uint8_t *ring;
/* 8.192 s of PCM16 at 16 kHz, in existing external PSRAM. This is not
 * additional DMA memory and cannot overwrite or synthesize missing samples. */
#define CAPTURE_FIFO_BYTES (256 * 1024)
static uint8_t *capture_buffer;
static lj_pcm_fifo_t capture_fifo;
static TaskHandle_t storage_writer;
static uint32_t accepted_bytes;
static size_t queued_peak;
static const char *source_failure;
static bool armed, available;
static bool sealed;
static FILE *file;
static char part[LJ_PATH_MAX], path[LJ_PATH_MAX];
static uint32_t live_done_stream;
static unsigned started_overruns;
static mbedtls_sha256_context hash;

lj_capture_t lj_capture_snapshot(void) {
    lj_capture_t s;
    xSemaphoreTake(lock, portMAX_DELAY); s = cap; xSemaphoreGive(lock); return s;
}
bool lj_capture_repair_ready(void) { return available && ring; }
esp_err_t lj_capture_copy(const char *session, uint32_t stream, uint32_t offset,
                          size_t bytes, uint8_t *out, size_t out_capacity) {
    if (!session || !out || !bytes || bytes > LJ_LIVE_REPAIR_MAX || bytes % 2 || offset % 2 || bytes > out_capacity)
        return ESP_ERR_INVALID_ARG;
    if (!lj_capture_repair_ready()) return ESP_ERR_NOT_SUPPORTED;
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t result = ESP_ERR_INVALID_STATE;
    if (cap.active && cap.live && !cap.finalizing && cap.stream == stream && !strcmp(cap.session, session))
        result = lj_ring_copy(ring, LJ_LIVE_RING, cap.bytes, offset, bytes, out, out_capacity) ? ESP_OK : ESP_ERR_NOT_FOUND;
    xSemaphoreGive(lock);
    return result;
}
esp_err_t lj_capture_start(const char *session, bool live, bool schedule) {
    if (!available || !ring || !capture_buffer) return ESP_ERR_NOT_SUPPORTED;
    if (!lj_storage_ready()) return ESP_ERR_NOT_FOUND;
    if (!session || !*session || strlen(session) >= sizeof(cap.session)) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(lj_fs_mutex, portMAX_DELAY);
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t e = ESP_ERR_INVALID_STATE;
    if (cap.active || cap.finalizing || lj_storage_pinned()) goto done;
    if (lj_storage_free() < 1048576) { e = ESP_ERR_NO_MEM; goto done; }
    memset(&cap, 0, sizeof(cap));
    lj_pcm_fifo_init(&capture_fifo, capture_buffer, CAPTURE_FIFO_BYTES);
    accepted_bytes = 0; queued_peak = 0; source_failure = NULL;
    snprintf(cap.session, sizeof(cap.session), "%s", session);
    cap.created_ms = lj_epoch_ms(); cap.stream = esp_random() | 1u;
    cap.context.schedule = schedule; cap.context.epoch_ms = cap.created_ms;
    snprintf(cap.context.id, sizeof(cap.context.id), "%s", session);
    snprintf(cap.context.timezone, sizeof(cap.context.timezone), "%s", lj_timezone());
    /* Random suffix prevents overwrite even after RTC reset / rapid starts. */
    snprintf(cap.name, sizeof(cap.name), "LJ_%" PRId64 "_%08" PRIx32 ".wav", cap.created_ms, esp_random());
    snprintf(path, sizeof(path), LJ_DISK "/%s", cap.name);
    snprintf(part, sizeof(part), LJ_DISK "/%s.part", cap.name);
    int fd = open(part, O_CREAT | O_EXCL | O_RDWR, 0600);
    if (fd < 0) { e = ESP_FAIL; goto done; }
    file = fdopen(fd, "wb+");
    if (!file) { close(fd); e = ESP_FAIL; goto done; }
    uint8_t h[LJ_CAPTURE_HEADER_BYTES]; lj_context_header(h, 0, &cap.context);
    if (fwrite(h, 1, sizeof(h), file) != sizeof(h) || fflush(file) || fsync(fd)) {
        fclose(file); file = NULL; e = ESP_FAIL; goto done;
    }
    mbedtls_sha256_init(&hash); mbedtls_sha256_starts(&hash, 0);
    cap.active = true; cap.live = live; armed = false; sealed = false;
    started_overruns = lj_board_overruns(); live_done_stream = 0;
    e = ESP_OK;
done:
    xSemaphoreGive(lock); xSemaphoreGive(lj_fs_mutex); return e;
}
void lj_capture_activate(void) {
    xSemaphoreTake(lock, portMAX_DELAY); armed = true; started_overruns = lj_board_overruns(); xSemaphoreGive(lock);
    if (storage_writer) xTaskNotifyGive(storage_writer);
}
esp_err_t lj_capture_pause(bool pause) {
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t e = cap.active && !cap.finalizing ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (e == ESP_OK) cap.paused = pause;
    xSemaphoreGive(lock); return e;
}
esp_err_t lj_capture_stop(void) {
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t e = cap.active ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (e == ESP_OK) cap.finalizing = true;
    xSemaphoreGive(lock);
    if (e == ESP_OK && storage_writer) xTaskNotifyGive(storage_writer);
    return e;
}
void lj_capture_disconnect(void) {
    /* SD recording continues. A reconnect cannot invent an earlier live prefix. */
    xSemaphoreTake(lock, portMAX_DELAY); cap.live = false; xSemaphoreGive(lock);
}
static void finish(const char *failure) {
    lj_capture_t s = lj_capture_snapshot(); lj_recording_t meta = {0};
    xSemaphoreTake(lj_fs_mutex, portMAX_DELAY);
    bool ok = file != NULL;
    if (ok) {
        uint8_t h[LJ_CAPTURE_HEADER_BYTES], digest[32]; char sha[72] = "sha256:";
        lj_context_header(h, s.bytes, &s.context);
        ok = !fseek(file, 0, SEEK_SET) && fwrite(h, 1, sizeof(h), file) == sizeof(h) && !fflush(file) && !fsync(fileno(file));
        if (fclose(file)) ok = false;
        file = NULL;
        mbedtls_sha256_finish(&hash, digest); mbedtls_sha256_free(&hash);
        for (unsigned i = 0; i < 32; ++i) snprintf(sha + 7 + 2 * i, 3, "%02x", digest[i]);
        if (ok && !failure && !rename(part, path))
            ok = lj_storage_committed(s.name, s.bytes, sha, s.created_ms, &meta) == ESP_OK;
        else ok = false;
    }
    xSemaphoreGive(lj_fs_mutex);
    xSemaphoreTake(lock, portMAX_DELAY); sealed = true; xSemaphoreGive(lock);
    /* Let the live sender drain. Bounded: never stall finalization behind radio. */
    int64_t until = esp_timer_get_time() + 1500000;
    while (s.live && lj_ble_audio_ready() && esp_timer_get_time() < until) {
        xSemaphoreTake(lock, portMAX_DELAY); bool sent = live_done_stream == s.stream; xSemaphoreGive(lock);
        if (sent) break;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    xSemaphoreTake(lock, portMAX_DELAY);
    cap.active = cap.finalizing = cap.paused = false; armed = false;
    xSemaphoreGive(lock);
    lj_control_finished(&s, &meta, failure ? failure : ok ? NULL : "storage_failed");
    ESP_LOGI("capture", "finalized bytes=%" PRIu32 " result=%s", s.bytes, failure ? failure : ok ? "ok" : "storage_failed");
}
/* The only I2S consumer never waits for FatFS, SHA, BLE or fsync. The writer
 * still owns all file/committed-ring/hash operations. Both queue cursors are
 * protected by the short capture lock, never by the filesystem mutex. */
static void capture_task(void *unused) {
    (void)unused;
    int16_t pcm[512];
    for (;;) {
        size_t n = 0;
        esp_err_t e = lj_board_read(pcm, 512, &n);
        if (e != ESP_OK && !available) { vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        xSemaphoreTake(lock, portMAX_DELAY);
        bool notify = false, failed = false;
        unsigned current_overruns = lj_board_overruns();
        if (cap.active && armed && !cap.finalizing) {
            if (cap.paused) started_overruns = current_overruns;
            else if (e != ESP_OK || n == 0 || current_overruns != started_overruns) {
                cap.finalizing = true; source_failure = "audio_failed"; notify = failed = true;
            } else if ((uint64_t)accepted_bytes + n * 2 > UINT32_MAX - LJ_CAPTURE_HEADER_BYTES) {
                cap.finalizing = true; source_failure = "storage_failed"; notify = failed = true;
            } else if (!lj_pcm_fifo_put(&capture_fifo, pcm, n * 2)) {
                cap.finalizing = true; source_failure = "audio_failed"; notify = failed = true;
            } else {
                accepted_bytes += n * 2;
                if (capture_fifo.used > queued_peak) queued_peak = capture_fifo.used;
                notify = true;
            }
        }
        unsigned baseline = started_overruns;
        size_t queued = capture_fifo.used;
        xSemaphoreGive(lock);
        if (notify && storage_writer) xTaskNotifyGive(storage_writer);
        if (failed) ESP_LOGE("capture", "input_failure code=%d samples=%u overruns=%u baseline=%u queued=%u",
            (int)e, (unsigned)n, current_overruns, baseline, (unsigned)queued);
    }
}

static void storage_task(void *unused) {
    (void)unused;
    uint8_t pcm[1024];
    uint32_t measured_stream = 0;
    int64_t flushed = 0, wait_max_us = 0, write_max_us = 0, sync_max_us = 0;
    unsigned sync_count = 0;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        for (;;) {
            xSemaphoreTake(lock, portMAX_DELAY);
            lj_capture_t s = cap;
            bool go = s.active && armed;
            size_t bytes = go ? lj_pcm_fifo_get(&capture_fifo, pcm, sizeof(pcm)) : 0;
            const char *failure = source_failure;
            size_t peak = queued_peak;
            uint32_t accepted = accepted_bytes;
            xSemaphoreGive(lock);
            if (!go) break;
            if (measured_stream != s.stream) {
                measured_stream = s.stream;
                flushed = esp_timer_get_time();
                wait_max_us = write_max_us = sync_max_us = 0; sync_count = 0;
            }
            if (!bytes) {
                if (s.finalizing) {
                    ESP_LOGI("capture", "io_summary accepted=%" PRIu32 " committed=%" PRIu32
                        " queue_peak=%u fs_wait_max_us=%" PRId64 " write_max_us=%" PRId64
                        " sync_max_us=%" PRId64 " syncs=%u", accepted, s.bytes, (unsigned)peak,
                        wait_max_us, write_max_us, sync_max_us, sync_count);
                    finish(failure);
                }
                break;
            }
            int64_t io_start = esp_timer_get_time();
            xSemaphoreTake(lj_fs_mutex, portMAX_DELAY);
            int64_t write_start = esp_timer_get_time();
            if (write_start - io_start > wait_max_us) wait_max_us = write_start - io_start;
            bool ok = file && fwrite(pcm, 1, bytes, file) == bytes;
            int64_t write_us = esp_timer_get_time() - write_start;
            if (write_us > write_max_us) write_max_us = write_us;
            if (ok && esp_timer_get_time() - flushed > 1000000) {
                int64_t sync_start = esp_timer_get_time();
                ok = !fflush(file) && !fsync(fileno(file)); flushed = esp_timer_get_time();
                int64_t sync_us = flushed - sync_start;
                if (sync_us > sync_max_us) sync_max_us = sync_us;
                ++sync_count;
            }
            xSemaphoreGive(lj_fs_mutex);
            if (!ok) {
                xSemaphoreTake(lock, portMAX_DELAY); cap.finalizing = true; xSemaphoreGive(lock);
                finish("storage_failed"); break;
            }
            mbedtls_sha256_update(&hash, pcm, bytes);
            xSemaphoreTake(lock, portMAX_DELAY);
            size_t at = cap.bytes % LJ_LIVE_RING;
            size_t first = bytes < LJ_LIVE_RING - at ? bytes : LJ_LIVE_RING - at;
            memcpy(ring + at, pcm, first); memcpy(ring, pcm + first, bytes - first);
            cap.bytes += bytes; xSemaphoreGive(lock);
        }
    }
}
static void live_task(void *unused) {
    (void)unused;
    uint32_t stream = 0, seq = 0; uint64_t cursor = 0;
    uint8_t pcm[492];
    for (;;) {
        lj_capture_t s = lj_capture_snapshot();
        if (!s.active || !s.live || !lj_ble_audio_ready()) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (stream != s.stream) { stream = s.stream; cursor = 0; seq = 0; }
        size_t limit = lj_pcm_capacity(lj_ble_mtu());
        if (!limit) { vTaskDelay(pdMS_TO_TICKS(20)); continue; }
        xSemaphoreTake(lock, portMAX_DELAY);
        uint64_t end = cap.bytes;
        size_t n = lj_ring_window(end, &cursor, LJ_LIVE_RING, limit);
        if (n < limit && !sealed) n = 0; /* coalesce the short I2S tail, never pad it */
        if (n) {
            size_t at = cursor % LJ_LIVE_RING, first = n < LJ_LIVE_RING - at ? n : LJ_LIVE_RING - at;
            memcpy(pcm, ring + at, first); memcpy(pcm + first, ring, n - first);
        }
        bool final = cap.finalizing && sealed && !n;
        bool already_done = live_done_stream == stream;
        xSemaphoreGive(lock);
        if (n || (final && !already_done)) {
            uint32_t next = seq + 1; if (!next) next = 1;
            if (lj_ble_audio(0x10, final, stream, next, cursor, pcm, n, 100) == ESP_OK) {
                seq = next; cursor += n;
                if (final) { xSemaphoreTake(lock, portMAX_DELAY); live_done_stream = stream; xSemaphoreGive(lock); }
            } else vTaskDelay(pdMS_TO_TICKS(5));
        } else vTaskDelay(pdMS_TO_TICKS(5));
    }
}
void lj_recorder_init(void) {
    lock = xSemaphoreCreateMutex();
    ring = heap_caps_malloc(LJ_LIVE_RING, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    capture_buffer = heap_caps_malloc(CAPTURE_FIFO_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    available = lj_board_init() == ESP_OK && ring && capture_buffer;
    if (available) available = xTaskCreatePinnedToCore(storage_task, "pcm-store", 8192, NULL, 7, &storage_writer, 1) == pdPASS;
    if (available) available = xTaskCreatePinnedToCore(capture_task, "pcm-owner", 8192, NULL, 8, NULL, 1) == pdPASS;
    xTaskCreate(live_task, "live-sender", 4096, NULL, 4, NULL);
    ESP_LOGI("capture", "ready=%d live_ring=%d", available, ring != NULL);
}
