#include "lj.h"
#include "wifi_lease.h"
#include "wire.h"
#include <inttypes.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_wifi_default.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "lwip/tcp.h"

static SemaphoreHandle_t lock;
static bool initialized;
static atomic_bool active, connected;
static atomic_int_fast64_t expiry;
static atomic_uint admitted_requests;
static int admitted_socket = -1; /* lock-owned, descriptor remains HTTP-server owned */
static char ssid[33], password[17], token[65];
static httpd_handle_t server;
static esp_netif_t *netif;
#define DOWNLOAD_BUFFER_BYTES 4096
/* HTTP handlers run on one server worker. Keep the bounded bulk workspace in
 * PSRAM, not on its stack (SDK/parser/FatFS also need stack during HEAD/GET). */
static uint8_t *download_buffer;

bool lj_wifi_active(void) { return atomic_load(&active); }
static bool send_all(httpd_req_t *r, const void *data, size_t len) {
    const char *p = data;
    while (len) {
        int n = httpd_send(r, p, len);
        if (n <= 0) return false;
        p += n; len -= n;
    }
    return true;
}
static esp_err_t http_error_extra(httpd_req_t *r, const char *status, const char *code, const char *extra) {
    char body[240], header[400];
    int n = snprintf(body, sizeof(body), "{\"schema_version\":1,\"op\":\"recording.download\",\"ok\":false,\"error\":{\"code\":\"%s\",\"message\":\"%s\",\"retryable\":false}}", code, code);
    int h = snprintf(header, sizeof(header), "HTTP/1.1 %s\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: %d\r\n%sCache-Control: no-store\r\nConnection: close\r\n\r\n", status, n, extra);
    send_all(r, header, h);
    if (r->method != HTTP_HEAD) send_all(r, body, n);
    httpd_sess_trigger_close(r->handle, httpd_req_to_sockfd(r)); return ESP_OK;
}
static esp_err_t http_error(httpd_req_t *r, const char *status, const char *code) {
    return http_error_extra(r, status, code, !strncmp(status, "401 ", 4) ? "WWW-Authenticate: Bearer\r\n" : "");
}
static bool header(httpd_req_t *r, const char *key, char *dst, size_t cap) {
    size_t n = httpd_req_get_hdr_value_len(r, key);
    if (!n) { dst[0] = 0; return true; }
    return n < cap && httpd_req_get_hdr_value_str(r, key, dst, cap) == ESP_OK;
}
static esp_err_t download_admitted(httpd_req_t *r) {
    int64_t began = esp_timer_get_time(), read_us = 0, send_us = 0;
    /* The 4 KiB application chunks are not multiples of TCP MSS. A partially
     * filled segment must not wait for the peer's delayed ACK before more SD
     * data can enter the small embedded send window. No wire format changes. */
    int no_delay = 1;
    if (setsockopt(httpd_req_to_sockfd(r), IPPROTO_TCP, TCP_NODELAY, &no_delay, sizeof(no_delay)))
        ESP_LOGW("wifi", "TCP no-delay unavailable");
    char name[LJ_NAME_MAX + 1];
    if (strncmp(r->uri, "/recording/", 11) || !lj_decode_name(r->uri + 11, name, sizeof(name))) return http_error(r, "400 Bad Request", "invalid_argument");
    if (lj_capture_snapshot().active) return http_error(r, "409 Conflict", "busy");
    lj_recording_t m;
    xSemaphoreTake(lj_fs_mutex, portMAX_DELAY);
    esp_err_t e = lj_storage_meta(name, &m);
    if (e == ESP_OK) lj_storage_pin(true);
    xSemaphoreGive(lj_fs_mutex);
    if (e != ESP_OK) return http_error(r, "404 Not Found", "recording_not_found");
    char etag[80], match[80] = "", if_range[80] = "", range[100] = "";
    snprintf(etag, sizeof(etag), "\"%s\"", m.generation);
    const char *error_status = NULL, *error_code = NULL;
    bool has_headers = header(r, "If-Match", match, sizeof(match)) && header(r, "If-Range", if_range, sizeof(if_range)) && header(r, "Range", range, sizeof(range));
    if (!has_headers) { error_status = "400 Bad Request"; error_code = "invalid_argument"; }
    else if (*match && strcmp(match, "*") && strcmp(match, etag)) { error_status = "412 Precondition Failed"; error_code = "resume_mismatch"; }
    if (*if_range && strcmp(if_range, etag)) range[0] = 0;
    uint64_t start = 0, length = m.file_bytes;
    if (!error_status && !lj_http_range(range, m.file_bytes, &start, &length)) {
        error_status = strchr(range, ',') ? "400 Bad Request" : "416 Range Not Satisfiable";
        error_code = "range_not_satisfiable";
    }
    lj_reader_t reader = {0}; FILE *f = NULL;
    if (!error_status) {
        char path[LJ_PATH_MAX]; snprintf(path, sizeof(path), LJ_DISK "/%s", name);
        if (lj_reader_open(&reader, path)) f = reader.file;
        if (!f || fseek(f, start, SEEK_SET)) { error_status = "500 Internal Server Error"; error_code = "storage_failed"; }
    }
    if (error_status) {
        lj_reader_close(&reader);
        xSemaphoreTake(lj_fs_mutex, portMAX_DELAY); lj_storage_pin(false); xSemaphoreGive(lj_fs_mutex);
        char extra[80] = "";
        if (!strncmp(error_status, "416", 3)) snprintf(extra, sizeof(extra), "Content-Range: bytes */%" PRIu32 "\r\n", m.file_bytes);
        return http_error_extra(r, error_status, error_code, extra);
    }
    char headers[800], content_range[120] = "";
    if (*range) snprintf(content_range, sizeof(content_range), "Content-Range: bytes %" PRIu64 "-%" PRIu64 "/%" PRIu32 "\r\n", start, start + length - 1, m.file_bytes);
    int n = snprintf(headers, sizeof(headers), "HTTP/1.1 %s\r\nContent-Type: audio/wav\r\nContent-Length: %" PRIu64 "\r\nAccept-Ranges: bytes\r\nETag: %s\r\nX-Recording-Id: %s\r\nX-Checksum-SHA256: %s\r\nX-Checksum-Scope: audio_payload\r\n%sCache-Control: no-store\r\nConnection: close\r\n\r\n",
                     *range ? "206 Partial Content" : "200 OK", length, etag, m.name, m.sha, content_range);
    bool ok = n > 0 && n < sizeof(headers) && send_all(r, headers, n);
    uint64_t remaining = length;
    while (ok && r->method != HTTP_HEAD && remaining) {
        if (!lj_wifi_can_continue(active, true)) { ok = false; break; }
        size_t want = remaining < DOWNLOAD_BUFFER_BYTES ? remaining : DOWNLOAD_BUFFER_BYTES;
        int64_t at = esp_timer_get_time();
        size_t got = fread(download_buffer, 1, want, f);
        read_us += esp_timer_get_time() - at;
        if (got != want) { ok = false; break; }
        at = esp_timer_get_time();
        bool sent = send_all(r, download_buffer, want);
        send_us += esp_timer_get_time() - at;
        if (!sent) { ok = false; break; }
        remaining -= want;
    }
    lj_reader_close(&reader);
    xSemaphoreTake(lj_fs_mutex, portMAX_DELAY); lj_storage_pin(false); xSemaphoreGive(lj_fs_mutex);
    ESP_LOGI("wifi", "download bytes=%" PRIu64 " success=%d elapsed_ms=%" PRId64 " read_ms=%" PRId64 " send_ms=%" PRId64 " stack_free=%u", r->method == HTTP_HEAD ? 0 : length - remaining, ok,
             (esp_timer_get_time() - began) / 1000, read_us / 1000, send_us / 1000, (unsigned)uxTaskGetStackHighWaterMark(NULL));
    httpd_sess_trigger_close(r->handle, httpd_req_to_sockfd(r));
    return ESP_OK;
}
static esp_err_t download(httpd_req_t *r) {
    char auth[100], expected[80];
    if (!header(r, "Authorization", auth, sizeof(auth))) return http_error(r, "401 Unauthorized", "unauthorized");
    xSemaphoreTake(lock, portMAX_DELAY);
    snprintf(expected, sizeof(expected), "Bearer %s", token);
    bool authorized = lj_wifi_can_admit(active, esp_timer_get_time(), expiry) && strlen(auth) == strlen(expected);
    unsigned difference = 0;
    if (authorized) for (size_t i = 0; i < strlen(expected); ++i) difference |= (unsigned char)auth[i] ^ (unsigned char)expected[i];
    authorized = authorized && !difference;
    if (authorized) { atomic_fetch_add(&admitted_requests, 1); admitted_socket = httpd_req_to_sockfd(r); }
    xSemaphoreGive(lock);
    if (!authorized) return http_error(r, "401 Unauthorized", "unauthorized");
    /* Every early HTTP error and HEAD response releases admission too. */
    esp_err_t result = download_admitted(r);
    xSemaphoreTake(lock, portMAX_DELAY);
    admitted_socket = -1;
    atomic_fetch_sub(&admitted_requests, 1);
    xSemaphoreGive(lock);
    return result;
}
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg; (void)base; (void)data;
    if (id == WIFI_EVENT_AP_STACONNECTED) atomic_store(&connected, true);
    if (id == WIFI_EVENT_AP_STADISCONNECTED) atomic_store(&connected, false);
    if (id == WIFI_EVENT_AP_START || id == WIFI_EVENT_AP_STACONNECTED || id == WIFI_EVENT_AP_STADISCONNECTED)
        lj_control_internal("wifi.changed");
}
static esp_err_t prepare(void) {
    if (initialized) return ESP_OK;
    if (!download_buffer) download_buffer = heap_caps_malloc(DOWNLOAD_BUFFER_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!download_buffer) return ESP_ERR_NO_MEM;
    netif = esp_netif_create_default_wifi_ap();
    if (!netif) return ESP_ERR_NO_MEM;
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    /* This source owner never imports the donor's private Wi-Fi NVS settings.
     * Keep that namespace intact for rollback; temporary AP settings are RAM. */
    cfg.nvs_enable = 0;
    esp_err_t e = esp_wifi_init(&cfg);
    if (e != ESP_OK) { esp_netif_destroy_default_wifi(netif); netif = NULL; return e; }
    e = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL);
    if (e == ESP_OK) e = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (e == ESP_OK) e = esp_wifi_set_mode(WIFI_MODE_AP);
    if (e != ESP_OK) { esp_wifi_deinit(); esp_netif_destroy_default_wifi(netif); netif = NULL; return e; }
    initialized = true; return ESP_OK;
}
void lj_wifi_close_for(const char *reason) {
    int64_t began = esp_timer_get_time();
    xSemaphoreTake(lock, portMAX_DELAY);
    bool was = active; atomic_store(&active, false); atomic_store(&connected, false);
    token[0] = 0;
    httpd_handle_t old = server; server = NULL;
    int in_flight = admitted_socket;
    xSemaphoreGive(lock);
    /* Explicit revocation must wake a blocked send, not queue behind its peer's
     * retransmission timeout. BSD shutdown is thread-safe in ESP-lwIP. Never
     * close/reuse the fd here: the HTTP server remains its sole close owner. */
    if (old && in_flight >= 0) shutdown(in_flight, SHUT_RDWR);
    if (old) httpd_stop(old);
    if (was && initialized) esp_wifi_stop();
    if (was) {
        char internal[48]; snprintf(internal, sizeof(internal), "wifi.off.%s", reason);
        lj_control_internal(internal);
        ESP_LOGI("wifi", "closed reason=%s elapsed_ms=%" PRId64 " interrupted_active=%d", reason,
                 (esp_timer_get_time() - began) / 1000, in_flight >= 0);
    }
}
void lj_wifi_close(void) { lj_wifi_close_for("app"); }
void lj_wifi_expire_if_idle(void) {
    /* Called by the serialized control owner. Re-check queued expiry signals:
     * an older signal must never close a newly issued offer. */
    xSemaphoreTake(lock, portMAX_DELAY);
    bool due = lj_wifi_should_expire(active, admitted_requests, esp_timer_get_time(), expiry);
    xSemaphoreGive(lock);
    if (due) lj_wifi_close_for("expired");
}
esp_err_t lj_wifi_offer(cJSON *reply) {
    xSemaphoreTake(lj_fs_mutex, portMAX_DELAY);
    bool pinned = lj_storage_pinned();
    xSemaphoreGive(lj_fs_mutex);
    if (pinned) return ESP_ERR_INVALID_STATE;
    lj_wifi_close();
    esp_err_t e = prepare(); if (e != ESP_OK) return e;
    /* Android remembers approval for a specific AP. The public MAC-derived
     * identity stays stable; neither its SSID nor its BSSID is a credential.
     * Password and bearer entropy remain independent and per-offer. */
    uint8_t ap_mac[6];
    e = esp_read_mac(ap_mac, ESP_MAC_WIFI_SOFTAP); if (e != ESP_OK) return e;
    if (!lj_ap_ssid(ssid, sizeof(ssid), ap_mac)) return ESP_ERR_INVALID_SIZE;
    uint32_t random[10]; esp_fill_random(random, sizeof(random));
    snprintf(password, sizeof(password), "%08" PRIx32 "%08" PRIx32, random[0], random[1]);
    for (unsigned i = 0; i < 8; ++i) snprintf(token + 8 * i, 9, "%08" PRIx32, random[i + 2]);
    wifi_config_t config = {0};
    memcpy(config.ap.ssid, ssid, strlen(ssid));
    snprintf((char *)config.ap.password, sizeof(config.ap.password), "%s", password);
    config.ap.ssid_len = strlen(ssid); config.ap.channel = 1; config.ap.max_connection = 1;
    config.ap.authmode = WIFI_AUTH_WPA2_PSK; config.ap.pmf_cfg.required = false;
    /* Zero is outside the documented AP timing range. Do not depend on an
     * implicit fallback when using a fully initialized independent profile. */
    config.ap.beacon_interval = 100; config.ap.dtim_period = 1; config.ap.csa_count = 3;
    config.ap.pairwise_cipher = WIFI_CIPHER_TYPE_CCMP;
    e = esp_wifi_set_config(WIFI_IF_AP, &config);
    if (e == ESP_OK) e = esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW_HT20);
    if (e == ESP_OK) e = esp_wifi_start();
    if (e != ESP_OK) return e;
    httpd_config_t http = HTTPD_DEFAULT_CONFIG();
    http.stack_size = 8192; http.max_open_sockets = 2; http.lru_purge_enable = true;
    http.recv_wait_timeout = 5; http.send_wait_timeout = 5; http.uri_match_fn = httpd_uri_match_wildcard;
    e = httpd_start(&server, &http);
    if (e != ESP_OK) { esp_wifi_stop(); return e; }
    httpd_uri_t get = {.uri = "/recording/*", .method = HTTP_GET, .handler = download};
    httpd_uri_t head = {.uri = "/recording/*", .method = HTTP_HEAD, .handler = download};
    e = httpd_register_uri_handler(server, &get);
    if (e == ESP_OK) e = httpd_register_uri_handler(server, &head);
    if (e != ESP_OK) { httpd_stop(server); server = NULL; esp_wifi_stop(); return e; }
    xSemaphoreTake(lock, portMAX_DELAY);
    atomic_store(&expiry, esp_timer_get_time() + 120000000); atomic_store(&active, true);
    cJSON *o = cJSON_AddObjectToObject(reply, "wifi_offer");
    cJSON_AddStringToObject(o, "ssid", ssid); cJSON_AddStringToObject(o, "password", password);
    cJSON_AddStringToObject(o, "base_url", "http://192.168.4.1"); cJSON_AddStringToObject(o, "recording_base_path", "/recording/");
    cJSON_AddStringToObject(o, "bearer_token", token); cJSON_AddStringToObject(o, "security_mode", "development_http");
    cJSON_AddNullToObject(o, "certificate_sha256"); cJSON_AddNumberToObject(o, "expires_in_ms", 120000);
    if (lj_time_ready()) cJSON_AddNumberToObject(o, "expires_epoch_ms", lj_epoch_ms() + 120000); else cJSON_AddNullToObject(o, "expires_epoch_ms");
    xSemaphoreGive(lock);
    ESP_LOGI("wifi", "offered internal=%u largest=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    return ESP_OK;
}
void lj_wifi_status(cJSON *reply) {
    cJSON *w = cJSON_AddObjectToObject(reply, "wifi");
    bool on = active;
    cJSON_AddStringToObject(w, "state", !on ? "off" : connected ? "client_connected" : "ready");
    if (on) { cJSON_AddStringToObject(w, "ssid", ssid); cJSON_AddStringToObject(w, "device_ipv4", "192.168.4.1"); }
    else { cJSON_AddNullToObject(w, "ssid"); cJSON_AddNullToObject(w, "device_ipv4"); }
    cJSON_AddNullToObject(w, "client_ipv4");
    int64_t left = on ? (expiry - esp_timer_get_time()) / 1000 : 0; if (left < 0) left = 0;
    cJSON_AddNumberToObject(w, "expires_in_ms", left);
    if (on && lj_time_ready()) cJSON_AddNumberToObject(w, "expires_epoch_ms", lj_epoch_ms() + left); else cJSON_AddNullToObject(w, "expires_epoch_ms");
}
static void expiry_task(void *arg) {
    (void)arg;
    for (;;) {
        if (lj_wifi_should_expire(active, admitted_requests, esp_timer_get_time(), expiry)) lj_control_internal("wifi.expired");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
esp_err_t lj_wifi_init(void) {
    lock = xSemaphoreCreateMutex();
    esp_err_t e = esp_netif_init(); if (e != ESP_OK) return e;
    e = esp_event_loop_create_default(); if (e != ESP_OK) return e;
    xTaskCreate(expiry_task, "wifi-expiry", 2560, NULL, 2, NULL); return ESP_OK;
}
