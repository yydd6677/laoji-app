#include "lj.h"
#include "button_gesture.h"
#include <inttypes.h>
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"

static QueueHandle_t commands;
static bool hello_done;
static atomic_bool time_valid;
static char time_zone[64];
static bool pending_schedule;
static char pending_key[40];
static int64_t key_deadline;
static atomic_bool reading, read_cancel;
static atomic_uint read_stream, last_read_stream;
static atomic_bool repairing, repair_cancel;
static atomic_uint repair_stream, last_repair_stream;
static struct { char id[97]; uint8_t sha[32]; char *response; } dedupe[8];
static unsigned dedupe_next;

static const char *str(const cJSON *o, const char *key) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}
static bool integer(const cJSON *o, const char *key, double min, double max, double *out) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    if (!cJSON_IsNumber(v) || !isfinite(v->valuedouble) || v->valuedouble < min || v->valuedouble > max || floor(v->valuedouble) != v->valuedouble) return false;
    *out = v->valuedouble; return true;
}
int64_t lj_epoch_ms(void) {
    if (!time_valid) return 0;
    struct timeval tv; gettimeofday(&tv, NULL); return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}
bool lj_time_ready(void) { return time_valid; }
const char *lj_timezone(void) { return time_zone; }
bool lj_control_enqueue(const uint8_t *json, size_t n) {
    if (!commands || !n || n > 48 * 1024 || memchr(json, 0, n)) return false;
    char *copy = malloc(n + 1); if (!copy) return false;
    memcpy(copy, json, n); copy[n] = 0;
    cJSON *request = cJSON_Parse(copy);
    bool valid = cJSON_IsObject(request) && !cJSON_HasObjectItem(request, "_internal");
    cJSON_Delete(request);
    if (!valid) { free(copy); return false; }
    if (!xQueueSend(commands, &copy, 0)) { free(copy); return false; }
    return true;
}
static void internal_object(cJSON *o) {
    char *s = cJSON_PrintUnformatted(o); cJSON_Delete(o);
    if (s && !xQueueSend(commands, &s, pdMS_TO_TICKS(1000))) free(s);
}
void lj_control_internal(const char *op) {
    cJSON *o = cJSON_CreateObject(); cJSON_AddStringToObject(o, "_internal", op);
    if (!strncmp(op, "button.", 7)) {
        lj_capture_t s = lj_capture_snapshot();
        cJSON_AddBoolToObject(o, "active", s.active);
        cJSON_AddStringToObject(o, "capture_session", s.session);
        cJSON_AddNumberToObject(o, "pressed_at_us", esp_timer_get_time());
    }
    internal_object(o);
}
void lj_control_disconnected(void) { lj_control_internal("disconnected"); }
static cJSON *event(const char *op) {
    cJSON *o = cJSON_CreateObject(); cJSON_AddNumberToObject(o, "schema_version", 1);
    cJSON_AddStringToObject(o, "op", op); return o;
}
void lj_control_finished(const lj_capture_t *s, const lj_recording_t *m, const char *failure) {
    cJSON *o = event(failure ? "capture.interrupted" : "capture.finished");
    cJSON_AddStringToObject(o, "session_id", s->session);
    if (failure) cJSON_AddStringToObject(o, "reason", failure);
    else {
        cJSON *meta = lj_recording_json(m);
        while (meta->child) { cJSON *v = cJSON_DetachItemViaPointer(meta, meta->child); cJSON_AddItemToObject(o, v->string, v); }
        cJSON_Delete(meta);
        cJSON_AddNumberToObject(o, "stream_id", s->stream); cJSON_AddStringToObject(o, "source", "device");
        cJSON_AddStringToObject(o, "reason", "device");
    }
    cJSON *wrapper = cJSON_CreateObject(); cJSON_AddStringToObject(wrapper, "_internal", "event");
    cJSON_AddItemToObject(wrapper, "event", o); internal_object(wrapper);
}
static void fail(cJSON *r, const char *code, bool retryable) {
    cJSON_ReplaceItemInObject(r, "ok", cJSON_CreateFalse());
    cJSON *e = cJSON_AddObjectToObject(r, "error");
    cJSON_AddStringToObject(e, "code", code); cJSON_AddStringToObject(e, "message", code);
    cJSON_AddBoolToObject(e, "retryable", retryable);
}
static void start_event(void) {
    lj_capture_t s = lj_capture_snapshot();
    cJSON *o = event("capture.started");
    cJSON_AddStringToObject(o, "session_id", s.session); cJSON_AddStringToObject(o, "recording_id", s.name);
    cJSON_AddNumberToObject(o, "stream_id", s.stream); cJSON_AddStringToObject(o, "source", "device");
    cJSON_AddItemToObject(o, "audio", lj_audio_json());
    cJSON_AddStringToObject(o, "purpose", s.context.schedule ? "schedule" : "meeting");
    cJSON_AddNumberToObject(o, "created_epoch_ms", s.context.epoch_ms);
    cJSON_AddStringToObject(o, "time_zone", s.context.timezone);
    cJSON_AddStringToObject(o, "capture_id", s.context.id);
    lj_ble_json(o); cJSON_Delete(o);
    lj_capture_activate();
}
static void key_start(bool live) {
    char session[80]; snprintf(session, sizeof(session), "key-%08" PRIx32 "-%08" PRIx32, esp_random(), esp_random());
    if (lj_capture_start(session, live, pending_schedule) == ESP_OK) start_event();
    pending_key[0] = 0;
}
static void capture_change_event(bool pause) {
    lj_capture_t s = lj_capture_snapshot(); cJSON *o = event(pause ? "capture.paused" : "capture.resumed");
    cJSON_AddStringToObject(o, "session_id", s.session); cJSON_AddStringToObject(o, "source", "device");
    lj_ble_json(o); cJSON_Delete(o);
}
static void button(const char *op) {
    lj_capture_t s = lj_capture_snapshot();
    lj_key_action_t action = lj_key_action(!strcmp(op, "button.long") ? LJ_KEY_LONG :
        !strcmp(op, "button.double") ? LJ_KEY_DOUBLE : LJ_KEY_SHORT, s.active, s.paused,
        s.finalizing || *pending_key || (!s.active && (reading || repairing || lj_wifi_active())));
    if (action == LJ_ACTION_NONE) return;
    if (s.active) {
        if (action == LJ_ACTION_STOP) lj_capture_stop();
        else if (lj_capture_pause(action == LJ_ACTION_PAUSE) == ESP_OK) capture_change_event(action == LJ_ACTION_PAUSE);
    } else {
        pending_schedule = action == LJ_ACTION_SCHEDULE;
        if (hello_done && lj_ble_ready()) {
            snprintf(pending_key, sizeof(pending_key), "key-%08" PRIx32, esp_random());
            cJSON *o = event("capture.requested"); cJSON_AddStringToObject(o, "request_id", pending_key);
            cJSON_AddStringToObject(o, "source", "device"); cJSON_AddNumberToObject(o, "timeout_ms", 300);
            cJSON_AddStringToObject(o, "purpose", pending_schedule ? "schedule" : "meeting");
            /* Deadline starts before transmission; slow/unsubscribed peer cannot delay local recording. */
            key_deadline = esp_timer_get_time() + 300000;
            lj_ble_key_request(o); cJSON_Delete(o);
        } else key_start(false);
    }
}
typedef struct { lj_recording_t m; uint32_t stream, offset, length; } read_job_t;
typedef struct { char session[96]; uint32_t source_stream, stream, offset, length; uint8_t *pcm; } repair_job_t;
static void repair_task(void *arg) {
    repair_job_t *j = arg;
    uint32_t sent = 0, seq = 0;
    int64_t started = esp_timer_get_time(), deadline = started + 2000000;
    while (!atomic_load(&repair_cancel) && sent < j->length && lj_ble_audio_ready() && esp_timer_get_time() < deadline) {
        lj_capture_t source = lj_capture_snapshot();
        if (!source.active || !source.live || source.finalizing || source.stream != j->source_stream || strcmp(source.session, j->session)) break;
        size_t n = lj_pcm_capacity(lj_ble_mtu());
        if (n > j->length - sent) n = j->length - sent;
        if (!n) break;
        uint32_t next = seq + 1; if (!next) next = 1;
        if (lj_ble_audio(0x11, sent + n == j->length, j->stream, next, j->offset + sent, j->pcm + sent, n, 50) == ESP_OK) {
            seq = next; sent += n;
        } else vTaskDelay(pdMS_TO_TICKS(5));
    }
    ESP_LOGI("control", "live_repair bytes=%" PRIu32 " expected=%" PRIu32 " elapsed_ms=%" PRId64,
        sent, j->length, (esp_timer_get_time() - started) / 1000);
    free(j->pcm);
    atomic_store(&last_repair_stream, j->stream); atomic_store(&repairing, false);
    free(j); vTaskDelete(NULL);
}
static void read_task(void *arg) {
    read_job_t *j = arg;
    char path[LJ_PATH_MAX]; snprintf(path, sizeof(path), LJ_DISK "/%s", j->m.name);
    lj_reader_t reader = {0};
    lj_reader_open(&reader, path);
    FILE *f = reader.file;
    bool ok = f && !fseek(f, j->m.data_offset + j->offset, SEEK_SET);
    uint32_t sent = 0, seq = 0;
    uint8_t pcm[492];
    while (ok && !atomic_load(&read_cancel) && sent < j->length && lj_ble_audio_ready()) {
        size_t n = lj_pcm_capacity(lj_ble_mtu());
        if (n > j->length - sent) n = j->length - sent;
        if (!n) { ok = false; break; }
        if (fread(pcm, 1, n, f) != n) { ok = false; break; }
        uint32_t next = seq + 1; if (!next) next = 1;
        int64_t deadline = esp_timer_get_time() + 5000000;
        do {
            ok = lj_ble_audio(0x11, sent + n == j->length, j->stream, next, j->offset + sent, pcm, n, 50) == ESP_OK;
        } while (!ok && !atomic_load(&read_cancel) && lj_ble_audio_ready() && esp_timer_get_time() < deadline);
        if (ok) { seq = next; sent += n; }
    }
    bool cancelled = atomic_load(&read_cancel);
    lj_reader_close(&reader);
    xSemaphoreTake(lj_fs_mutex, portMAX_DELAY); lj_storage_pin(false); xSemaphoreGive(lj_fs_mutex);
    atomic_store(&last_read_stream, j->stream); atomic_store(&reading, false);
    if (!cancelled && lj_ble_ready()) {
        cJSON *o = event("transfer.finished");
        cJSON_AddStringToObject(o, "transport", "ble"); cJSON_AddStringToObject(o, "recording_id", j->m.name);
        cJSON_AddStringToObject(o, "generation", j->m.generation); cJSON_AddNumberToObject(o, "stream_id", j->stream);
        cJSON_AddNumberToObject(o, "start_pcm_offset", j->offset); cJSON_AddNumberToObject(o, "sent_audio_bytes", sent);
        cJSON_AddNumberToObject(o, "total_audio_bytes", j->m.audio_bytes);
        cJSON_AddStringToObject(o, "reason", ok && sent == j->length ? "completed" : "internal_error");
        cJSON *w = cJSON_CreateObject(); cJSON_AddStringToObject(w, "_internal", "event"); cJSON_AddItemToObject(w, "event", o); internal_object(w);
    }
    free(j); vTaskDelete(NULL);
}
static void hello(cJSON *r) {
    cJSON *p = cJSON_AddObjectToObject(r, "protocol"); cJSON_AddNumberToObject(p, "major", 1); cJSON_AddNumberToObject(p, "minor", 3);
    cJSON *d = cJSON_AddObjectToObject(r, "device"); cJSON_AddStringToObject(d, "device_id", lj_device_id);
    cJSON_AddStringToObject(d, "model", "ESP32S3-VoiceMemo-V1"); cJSON_AddStringToObject(d, "firmware_revision", "laoji-recorder-" LJ_VERSION);
    cJSON_AddStringToObject(d, "hardware_revision", "voice-memo-v1.0-20260917");
    cJSON *sec = cJSON_AddObjectToObject(r, "security"); cJSON_AddStringToObject(sec, "mode", "development_ble");
    cJSON *c = cJSON_AddObjectToObject(r, "capabilities");
    cJSON_AddItemToObject(c, "transports", cJSON_Parse("[\"ble\",\"wifi\"]"));
    cJSON_AddItemToObject(c, "control", cJSON_Parse("[\"record_toggle\",\"record_pause_resume\"]"));
    cJSON *a = cJSON_AddObjectToObject(c, "capture");
    cJSON_AddItemToObject(a, "purposes", cJSON_Parse("[\"meeting\",\"schedule\"]"));
    cJSON_AddStringToObject(a, "button_gestures", "long_meeting_double_schedule_v1");
    cJSON_AddBoolToObject(a, "live_stream", true); cJSON_AddBoolToObject(a, "local_storage", lj_storage_ready());
    if (lj_capture_repair_ready()) {
        cJSON *repair = cJSON_AddObjectToObject(a, "live_range_repair");
        cJSON_AddNumberToObject(repair, "max_bytes", LJ_LIVE_REPAIR_MAX);
        cJSON_AddNumberToObject(repair, "retention_bytes", LJ_LIVE_RING);
    }
    cJSON_AddItemToObject(a, "codecs", cJSON_Parse("[\"pcm_s16le\"]")); cJSON_AddItemToObject(a, "sample_rates_hz", cJSON_Parse("[16000]"));
    cJSON_AddItemToObject(a, "channels", cJSON_Parse("[1]"));
    cJSON *power = cJSON_AddObjectToObject(c, "power");
    cJSON_AddBoolToObject(power, "battery_status", false); cJSON_AddBoolToObject(power, "soft_shutdown", false);
    cJSON *s = cJSON_AddObjectToObject(c, "storage");
    cJSON_AddBoolToObject(s, "available", lj_storage_ready()); cJSON_AddBoolToObject(s, "range_resume", true);
    cJSON_AddBoolToObject(s, "ble_audio_read", true); cJSON_AddNumberToObject(s, "ble_audio_chunk_size_bytes", lj_pcm_capacity(lj_ble_mtu()));
    cJSON_AddItemToObject(s, "file_management", cJSON_Parse("[\"get\",\"list\",\"rename\",\"delete\"]"));
    cJSON *w = cJSON_AddObjectToObject(c, "wifi"); cJSON_AddBoolToObject(w, "bulk_transfer", true);
    cJSON_AddItemToObject(w, "security_modes", cJSON_Parse("[\"development_http\"]"));
    hello_done = true;
}
static void task(void *unused) {
    (void)unused;
    for (;;) {
        char *raw = NULL;
        if (!xQueueReceive(commands, &raw, pdMS_TO_TICKS(20))) {
            if (*pending_key && esp_timer_get_time() >= key_deadline) key_start(false);
            continue;
        }
        cJSON *q = cJSON_Parse(raw);
        if (!cJSON_IsObject(q)) { cJSON_Delete(q); free(raw); continue; }
        const char *internal = str(q, "_internal");
        if (internal) {
            if (!strcmp(internal, "event")) lj_ble_json(cJSON_GetObjectItemCaseSensitive(q, "event"));
            else if (!strcmp(internal, "disconnected")) { hello_done = false; atomic_store(&read_cancel, true); atomic_store(&repair_cancel, true); if (*pending_key) key_start(false); lj_wifi_close(); }
            else if (!strcmp(internal, "wifi.expired")) lj_wifi_expire_if_idle();
            else if (!strncmp(internal, "wifi.off.", 9)) { cJSON *o = event("transport.wifi.state_changed"); cJSON_AddStringToObject(o, "state", "off"); cJSON_AddNullToObject(o, "client_ipv4"); cJSON_AddStringToObject(o, "reason", internal + 9); lj_ble_json(o); cJSON_Delete(o); }
            else if (!strcmp(internal, "wifi.changed")) { cJSON *o = event("transport.wifi.state_changed"), *w = cJSON_CreateObject(); lj_wifi_status(w); cJSON *state = cJSON_GetObjectItemCaseSensitive(w, "wifi"); cJSON_AddStringToObject(o, "state", str(state, "state")); cJSON_AddNullToObject(o, "client_ipv4"); cJSON_AddNullToObject(o, "reason"); lj_ble_json(o); cJSON_Delete(o); cJSON_Delete(w); }
            else if (!strncmp(internal, "button.", 7)) {
                lj_capture_t current = lj_capture_snapshot();
                const char *source = str(q, "capture_session"); double pressed;
                if (source && current.active == cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(q, "active")) &&
                    !strcmp(source, current.session) && integer(q, "pressed_at_us", 0, 9007199254740991.0, &pressed) &&
                    esp_timer_get_time() - (int64_t)pressed <= 1000000) button(internal);
            }
            cJSON_Delete(q); free(raw); continue;
        }
        const char *op = str(q, "op"), *cid = str(q, "command_id"); double v;
        if (!op || strlen(op) > 64 || !cid || !*cid || strlen(cid) > 96 || !integer(q, "schema_version", 1, 1, &v)) { cJSON_Delete(q); free(raw); continue; }
        uint8_t request_hash[32]; mbedtls_sha256((const uint8_t *)raw, strlen(raw), request_hash, 0);
        bool duplicate = false;
        for (unsigned i = 0; i < 8; ++i) if (dedupe[i].response && !strcmp(dedupe[i].id, cid)) {
            if (!memcmp(dedupe[i].sha, request_hash, 32)) { cJSON *old = cJSON_Parse(dedupe[i].response); if (!strcmp(op, "hello") && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(old, "ok"))) hello_done = true; lj_ble_json(old); cJSON_Delete(old); }
            else { cJSON *r = event(op); cJSON_AddStringToObject(r, "command_id", cid); cJSON_AddBoolToObject(r, "ok", true); fail(r, "invalid_argument", false); lj_ble_json(r); cJSON_Delete(r); }
            duplicate = true; break;
        }
        if (duplicate) { cJSON_Delete(q); free(raw); continue; }
        cJSON *r = event(op); cJSON_AddStringToObject(r, "command_id", cid); cJSON_AddBoolToObject(r, "ok", true);
        bool started = false, paused_event = false, resumed_event = false, resolve_start = false, resolve_live = false;
        read_job_t *read_job = NULL;
        repair_job_t *repair_job = NULL;
        lj_capture_t s = lj_capture_snapshot();
        if (!strcmp(op, "hello")) {
            bool supported = false; cJSON *p;
            cJSON_ArrayForEach(p, cJSON_GetObjectItemCaseSensitive(q, "supported_protocols"))
                if (integer(p, "major", 1, 1, &v) && integer(p, "minor", 3, 3, &v)) supported = true;
            if (supported) hello(r); else fail(r, "unsupported_protocol", false);
        } else if (!hello_done) fail(r, "invalid_state", false);
        else if (!strcmp(op, "diagnostics.ping")) { /* no side effect */ }
        else if (!strcmp(op, "time.sync")) {
            if (!integer(q, "epoch_ms", 1577836800000.0, 4102444800000.0, &v)) fail(r, "invalid_argument", false);
            else {
                const char *zone = str(q, "time_zone");
                if (zone && (strlen(zone) >= sizeof(time_zone) || strspn(zone, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/_+-") != strlen(zone))) fail(r, "invalid_argument", false);
                else { int64_t ms = v; struct timeval tv = {.tv_sec = ms / 1000, .tv_usec = (ms % 1000) * 1000}; settimeofday(&tv, NULL); time_valid = true;
                    snprintf(time_zone, sizeof(time_zone), "%s", zone ? zone : ""); }
            }
        } else if (!strcmp(op, "status.get")) {
            cJSON *st = cJSON_AddObjectToObject(r, "status");
            cJSON_AddStringToObject(st, "state", s.finalizing ? "finalizing" : s.active ? s.paused ? "paused" : "recording" : atomic_load(&reading) ? "transferring" : lj_storage_ready() ? "ready" : "error");
            if (s.active) { cJSON_AddStringToObject(st, "session_id", s.session); cJSON_AddStringToObject(st, "recording_id", s.name); }
            else { cJSON_AddNullToObject(st, "session_id"); cJSON_AddNullToObject(st, "recording_id"); }
            cJSON_AddNullToObject(st, "battery_percent");
            cJSON_AddNumberToObject(st, "recorded_audio_bytes", s.bytes);
            cJSON_AddStringToObject(st, "purpose", s.context.schedule ? "schedule" : "meeting");
            xSemaphoreTake(lj_fs_mutex, portMAX_DELAY);
            cJSON_AddNumberToObject(st, "storage_free_bytes", lj_storage_free()); cJSON_AddNumberToObject(st, "pending_recordings", lj_storage_count());
            xSemaphoreGive(lj_fs_mutex);
        } else if (!strcmp(op, "capture.request.resolve")) {
            const char *id = str(q, "request_id"); cJSON *live = cJSON_GetObjectItemCaseSensitive(q, "live_stream");
            if (!id || strcmp(id, pending_key) || !*pending_key || esp_timer_get_time() > key_deadline || !cJSON_IsBool(live)) fail(r, "invalid_state", false);
            else { resolve_live = cJSON_IsTrue(live) && lj_ble_audio_ready(); resolve_start = true; cJSON_AddStringToObject(r, "request_id", id); cJSON_AddBoolToObject(r, "live_stream", resolve_live); }
        } else if (!strcmp(op, "capture.start")) {
            const char *session = str(q, "session_id"); cJSON *a = cJSON_GetObjectItemCaseSensitive(q, "audio");
            const char *codec = str(a, "codec"); bool live = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(a, "live_stream"));
            if (!time_valid) fail(r, "time_sync_required", true);
            else if (!session || !codec || strcmp(codec, "pcm_s16le") || !integer(a, "sample_rate_hz", LJ_RATE, LJ_RATE, &v) || !integer(a, "channels", 1, 1, &v)) fail(r, "invalid_argument", false);
            else if (s.active || atomic_load(&reading) || atomic_load(&repairing) || lj_wifi_active() || *pending_key) fail(r, "busy", true);
            else if (live && !lj_ble_audio_ready()) fail(r, "invalid_state", true);
            else if (str(q, "purpose") && strcmp(str(q, "purpose"), "meeting") && strcmp(str(q, "purpose"), "schedule")) fail(r, "invalid_argument", false);
            else if (lj_capture_start(session, live, str(q, "purpose") && !strcmp(str(q, "purpose"), "schedule")) != ESP_OK) fail(r, "capture_unavailable", true);
            else { s = lj_capture_snapshot(); cJSON_AddStringToObject(r, "session_id", s.session); cJSON_AddStringToObject(r, "recording_id", s.name); started = true; }
        } else if (!strcmp(op, "capture.pause") || !strcmp(op, "capture.resume") || !strcmp(op, "capture.stop")) {
            const char *session = str(q, "session_id");
            if (!session || !s.active || strcmp(session, s.session) || s.finalizing) fail(r, "invalid_state", false);
            else {
                cJSON_AddStringToObject(r, "session_id", s.session);
                if (!strcmp(op, "capture.stop")) { atomic_store(&repair_cancel, true); lj_capture_stop(); }
                else if (!strcmp(op, "capture.pause")) { lj_capture_pause(true); paused_event = true; }
                else { lj_capture_pause(false); resumed_event = true; }
            }
        } else if (!strcmp(op, "capture.audio.read")) {
            const char *session = str(q, "session_id"); double stream = 0, offset = 0, length = 0;
            if (!session || !integer(q, "stream_id", 1, UINT32_MAX, &stream) ||
                !integer(q, "offset", 0, UINT32_MAX, &offset) || ((uint32_t)offset & 1) ||
                !integer(q, "length", 2, LJ_LIVE_REPAIR_MAX, &length) || ((uint32_t)length & 1)) fail(r, "invalid_argument", false);
            else if (!s.active || !s.live || s.finalizing || s.stream != (uint32_t)stream || strcmp(s.session, session)) fail(r, "invalid_state", false);
            else if (atomic_load(&repairing) || atomic_load(&reading) || !lj_ble_audio_ready()) fail(r, "busy", true);
            else {
                repair_job = calloc(1, sizeof(*repair_job));
                if (repair_job) repair_job->pcm = heap_caps_malloc((size_t)length, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                if (!repair_job || !repair_job->pcm) { free(repair_job); repair_job = NULL; fail(r, "busy", true); }
                else {
                    esp_err_t copied = lj_capture_copy(session, stream, offset, length, repair_job->pcm, length);
                    if (copied != ESP_OK) {
                        free(repair_job->pcm); free(repair_job); repair_job = NULL;
                        fail(r, copied == ESP_ERR_NOT_FOUND ? "source_range_unavailable" : "invalid_state", false);
                    } else {
                        snprintf(repair_job->session, sizeof(repair_job->session), "%s", session);
                        repair_job->source_stream = stream; repair_job->offset = offset; repair_job->length = length;
                        do { repair_job->stream = esp_random() | 1u; } while (repair_job->stream == s.stream || repair_job->stream == atomic_load(&read_stream));
                        atomic_store(&repair_stream, repair_job->stream); atomic_store(&repair_cancel, false); atomic_store(&repairing, true);
                        cJSON *t = cJSON_AddObjectToObject(r, "transfer");
                        cJSON_AddStringToObject(t, "transport", "ble"); cJSON_AddStringToObject(t, "session_id", session);
                        cJSON_AddNumberToObject(t, "source_stream_id", stream); cJSON_AddNumberToObject(t, "stream_id", repair_job->stream);
                        cJSON_AddStringToObject(t, "offset_scope", "audio_payload"); cJSON_AddNumberToObject(t, "offset", offset);
                        cJSON_AddNumberToObject(t, "length", length); cJSON_AddNumberToObject(t, "chunk_size_bytes", lj_pcm_capacity(lj_ble_mtu()));
                    }
                }
            }
        } else if (!strcmp(op, "capture.audio.read.cancel")) {
            if (!integer(q, "stream_id", 1, UINT32_MAX, &v) || ((uint32_t)v != atomic_load(&repair_stream) && (uint32_t)v != atomic_load(&last_repair_stream))) fail(r, "transfer_not_found", false);
            else {
                if ((uint32_t)v == atomic_load(&repair_stream)) atomic_store(&repair_cancel, true);
                while ((uint32_t)v == atomic_load(&repair_stream) && atomic_load(&repairing)) vTaskDelay(pdMS_TO_TICKS(5));
                cJSON_AddNumberToObject(r, "stream_id", v);
            }
        } else if (!strcmp(op, "recording.list")) {
            double limit = 32, offset = 0; const char *cursor = str(q, "cursor");
            if ((cJSON_HasObjectItem(q, "limit") && !integer(q, "limit", 1, 32, &limit)) || (cursor && (strlen(cursor) > 9 || strspn(cursor, "0123456789") != strlen(cursor)))) fail(r, "invalid_argument", false);
            else {
                if (cursor) offset = strtoul(cursor, NULL, 10);
                bool previews = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(q, "include_previews"));
                /* Keep optional metadata pages bounded even at the minimum BLE MTU. */
                if (previews && limit > 4) limit = 4;
                bool more; xSemaphoreTake(lj_fs_mutex, portMAX_DELAY);
                cJSON *list = lj_storage_list(offset, limit, &more);
                if (previews) {
                    cJSON *items = cJSON_AddArrayToObject(r, "previews");
                    cJSON *item;
                    cJSON_ArrayForEach(item, list) {
                        cJSON *preview = lj_storage_preview(cJSON_GetStringValue(item));
                        if (preview) cJSON_AddItemToArray(items, preview);
                    }
                }
                xSemaphoreGive(lj_fs_mutex);
                cJSON_AddItemToObject(r, "recordings", list);
                if (more) { char next[24]; snprintf(next, sizeof(next), "%u", (unsigned)offset + cJSON_GetArraySize(list)); cJSON_AddStringToObject(r, "next_cursor", next); }
                else cJSON_AddNullToObject(r, "next_cursor");
            }
        } else if (!strcmp(op, "recording.audio.read.cancel")) {
            if (!integer(q, "stream_id", 1, UINT32_MAX, &v) || ((uint32_t)v != atomic_load(&read_stream) && (uint32_t)v != atomic_load(&last_read_stream))) fail(r, "transfer_not_found", false);
            else {
                if ((uint32_t)v == atomic_load(&read_stream)) atomic_store(&read_cancel, true);
                /* The sender polls cancellation between bounded 50 ms retries.
                 * Confirm only after it can no longer emit an old-flow packet. */
                while ((uint32_t)v == atomic_load(&read_stream) && atomic_load(&reading)) vTaskDelay(pdMS_TO_TICKS(5));
                cJSON_AddNumberToObject(r, "stream_id", v);
            }
        } else if (!strncmp(op, "recording.", 10)) {
            const char *name = str(q, "recording_id"); const char *gen = str(q, "expected_generation");
            lj_recording_t meta;
            if (!lj_safe_name(name)) fail(r, "invalid_argument", false);
            else if (s.active || atomic_load(&reading)) fail(r, "invalid_state", true);
            else {
                xSemaphoreTake(lj_fs_mutex, portMAX_DELAY);
                esp_err_t e = lj_storage_meta(name, &meta);
                if (e != ESP_OK) fail(r, "recording_not_found", false);
                else if (!strcmp(op, "recording.get")) cJSON_AddItemToObject(r, "recording", lj_recording_json(&meta));
                else if (!gen || strcmp(gen, meta.generation)) {
                    fail(r, "resume_mismatch", false);
                    cJSON *d = cJSON_AddObjectToObject(cJSON_GetObjectItemCaseSensitive(r, "error"), "details"); cJSON_AddStringToObject(d, "actual_generation", meta.generation);
                } else if (!strcmp(op, "recording.audio.read")) {
                    double offset = 0, length = meta.audio_bytes;
                    if (lj_wifi_active() || !lj_ble_audio_ready() || !integer(q, "offset", 0, meta.audio_bytes ? meta.audio_bytes - 1 : 0, &offset) || ((uint32_t)offset & 1) ||
                        (cJSON_HasObjectItem(q, "length") && !integer(q, "length", 2, UINT32_MAX, &length)) || ((uint32_t)length & 1) || !meta.audio_bytes) fail(r, "invalid_argument", false);
                    else {
                        read_job = calloc(1, sizeof(*read_job));
                        if (!read_job) fail(r, "busy", true);
                        else {
                            *read_job = (read_job_t){.m = meta, .stream = esp_random() | 1u, .offset = offset,
                                .length = length > meta.audio_bytes - offset ? meta.audio_bytes - offset : length};
                            lj_storage_pin(true); atomic_store(&reading, true); atomic_store(&read_cancel, false); atomic_store(&read_stream, read_job->stream);
                            cJSON *t = cJSON_AddObjectToObject(r, "transfer");
                            cJSON_AddStringToObject(t, "transport", "ble"); cJSON_AddStringToObject(t, "recording_id", meta.name); cJSON_AddStringToObject(t, "generation", meta.generation);
                            cJSON_AddNumberToObject(t, "stream_id", read_job->stream); cJSON_AddStringToObject(t, "offset_scope", "audio_payload");
                            cJSON_AddNumberToObject(t, "offset", read_job->offset); cJSON_AddNumberToObject(t, "length", read_job->length);
                            cJSON_AddNumberToObject(t, "total_audio_bytes", meta.audio_bytes); cJSON_AddNumberToObject(t, "chunk_size_bytes", lj_pcm_capacity(lj_ble_mtu()));
                            cJSON_AddStringToObject(t, "checksum_sha256", meta.sha); cJSON_AddStringToObject(t, "checksum_scope", "audio_payload");
                        }
                    }
                } else if (!strcmp(op, "recording.rename") || !strcmp(op, "recording.delete")) {
                    if (lj_storage_pinned()) fail(r, "busy", true);
                    else {
                        char from[LJ_PATH_MAX], to[LJ_PATH_MAX]; snprintf(from, sizeof(from), LJ_DISK "/%s", name);
                        if (!strcmp(op, "recording.delete")) { if (unlink(from)) fail(r, "storage_failed", true); else lj_storage_forget(name); }
                        else {
                            const char *new_name = str(q, "new_recording_id");
                            if (!lj_safe_name(new_name) || strlen(new_name) < 5 || strcasecmp(new_name + strlen(new_name) - 4, ".wav")) fail(r, "invalid_argument", false);
                            else { snprintf(to, sizeof(to), LJ_DISK "/%s", new_name); if (!access(to, F_OK)) fail(r, "recording_already_exists", false); else if (rename(from, to)) fail(r, "storage_failed", true); else lj_storage_forget(name); }
                        }
                        lj_storage_invalidate();
                    }
                } else fail(r, "unsupported_operation", false);
                xSemaphoreGive(lj_fs_mutex);
            }
        } else if (!strcmp(op, "transport.wifi.offer")) {
            if (s.active || atomic_load(&reading)) fail(r, "busy", true);
            else if (lj_wifi_offer(r) != ESP_OK) fail(r, "wifi_unavailable", true);
        } else if (!strcmp(op, "transport.wifi.status")) lj_wifi_status(r);
        else if (!strcmp(op, "transport.wifi.close")) lj_wifi_close();
        else fail(r, "unsupported_operation", false);
        int idx = dedupe_next++ % 8;
        free(dedupe[idx].response); dedupe[idx].response = cJSON_PrintUnformatted(r);
        snprintf(dedupe[idx].id, sizeof(dedupe[idx].id), "%s", cid); memcpy(dedupe[idx].sha, request_hash, 32);
        esp_err_t sent = lj_ble_json(r);
        if (started) start_event();
        if (resolve_start) key_start(resolve_live);
        if (paused_event || resumed_event) capture_change_event(paused_event);
        if (read_job) {
            if (sent != ESP_OK || xTaskCreate(read_task, "stored-reader", 6144, read_job, 4, NULL) != pdPASS) {
                xSemaphoreTake(lj_fs_mutex, portMAX_DELAY); lj_storage_pin(false); xSemaphoreGive(lj_fs_mutex);
                atomic_store(&reading, false); free(read_job);
            }
        }
        if (repair_job && (sent != ESP_OK || xTaskCreate(repair_task, "live-repair", 4096, repair_job, 4, NULL) != pdPASS)) {
            atomic_store(&repairing, false); free(repair_job->pcm); free(repair_job);
        }
        ESP_LOGI("control", "op=%s ok=%d", op, cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(r, "ok")));
        cJSON_Delete(r); cJSON_Delete(q); free(raw);
        if (*pending_key && esp_timer_get_time() >= key_deadline) key_start(false);
    }
}
void lj_control_init(void) {
    commands = xQueueCreate(16, sizeof(char *));
    xTaskCreate(task, "control-owner", 16384, NULL, 5, NULL);
}
