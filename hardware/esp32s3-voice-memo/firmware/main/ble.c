#include "lj.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_gap.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "os/os_mempool.h"

#define UUID(n) BLE_UUID128_INIT(0x01,0x69,0x6a,0x6f,0x61,0x6c,0x4b,0x8a,0x6f,0x4a,0x6f,0x6d,n,0,0x7a,0x9f)
static const ble_uuid128_t service_uuid = UUID(1), rx_uuid = UUID(2), tx_uuid = UUID(3), audio_uuid = UUID(4);
static uint16_t tx_handle, audio_handle;
static atomic_uint conn = BLE_HS_CONN_HANDLE_NONE;
static atomic_bool tx_subscribed, audio_subscribed;
static atomic_int indicate_status;
static SemaphoreHandle_t json_mutex, indication;
static uint8_t own_addr;
static uint16_t frame_id;
/* Audio cannot exhaust the shared mbufs required to receive pause/stop or to
 * confirm control replies. Ownership returns to these pools on NimBLE free. */
static struct os_mempool audio_mem_pool, control_mem_pool;
static struct os_mbuf_pool audio_pool, control_pool;
static struct os_mbuf *packet(struct os_mbuf_pool *pool, const void *bytes, size_t len) {
    struct os_mbuf *m = os_mbuf_get_pkthdr(pool, 0);
    if (!m) return NULL;
    m->om_data += 16; /* ATT + L2CAP + HCI prepend headroom */
    if (os_mbuf_append(m, bytes, len)) { os_mbuf_free_chain(m); return NULL; }
    return m;
}
static struct { uint16_t id; uint8_t count, next; size_t used; int64_t at; uint8_t *bytes; } incoming;

bool lj_ble_ready(void) { return atomic_load(&conn) != BLE_HS_CONN_HANDLE_NONE && atomic_load(&tx_subscribed); }
bool lj_ble_audio_ready(void) { return lj_ble_ready() && atomic_load(&audio_subscribed) && lj_pcm_capacity(lj_ble_mtu()); }
unsigned lj_ble_mtu(void) { return lj_ble_ready() ? ble_att_mtu(atomic_load(&conn)) : 23; }

static int access_cb(uint16_t connection, uint16_t handle, struct ble_gatt_access_ctxt *ctx, void *arg) {
    (void)connection; (void)handle; (void)arg;
    if (ctx->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    uint8_t packet[512]; uint16_t size = OS_MBUF_PKTLEN(ctx->om);
    if (size < 7 || size > sizeof(packet) || os_mbuf_copydata(ctx->om, 0, size, packet)) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    uint16_t fid = lj_u16(packet), body = lj_u16(packet + 4);
    uint8_t index = packet[2], count = packet[3];
    if (!fid || !count || index >= count || body != size - 6) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    int64_t now = esp_timer_get_time();
    if (!index) { incoming.id = fid; incoming.count = count; incoming.next = 0; incoming.used = 0; incoming.at = now; }
    if (fid != incoming.id || count != incoming.count || index != incoming.next || now - incoming.at > 5000000 ||
        incoming.used + body > 48 * 1024) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    memcpy(incoming.bytes + incoming.used, packet + 6, body);
    incoming.used += body; incoming.next++;
    if (incoming.next == incoming.count) {
        const uint8_t *b = incoming.bytes;
        if (incoming.used < 8 || b[0] != 1 || b[1] != 3 || b[2] || b[3] || lj_u32(b + 4) != incoming.used - 8) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        if (!lj_control_enqueue(b + 8, incoming.used - 8)) return BLE_ATT_ERR_INSUFFICIENT_RES;
        incoming.id = 0;
    }
    return 0;
}
static const struct ble_gatt_svc_def services[] = {
    {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &service_uuid.u,
     .characteristics = (struct ble_gatt_chr_def[]) {
        {.uuid = &rx_uuid.u, .access_cb = access_cb, .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP},
        {.uuid = &tx_uuid.u, .access_cb = access_cb, .flags = BLE_GATT_CHR_F_INDICATE, .val_handle = &tx_handle},
        {.uuid = &audio_uuid.u, .access_cb = access_cb, .flags = BLE_GATT_CHR_F_NOTIFY, .val_handle = &audio_handle}, {0}}}, {0}
};
static int gap_cb(struct ble_gap_event *event, void *arg);
static void advertise(void) {
    struct ble_hs_adv_fields f = {0};
    f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    f.uuids128 = (ble_uuid128_t *)&service_uuid; f.num_uuids128 = 1; f.uuids128_is_complete = 1;
    int e = ble_gap_adv_set_fields(&f);
    struct ble_hs_adv_fields scan = {0};
    const char *name = "LaoJi Test Board";
    scan.name = (uint8_t *)name; scan.name_len = strlen(name); scan.name_is_complete = 1;
    if (!e) e = ble_gap_adv_rsp_set_fields(&scan);
    struct ble_gap_adv_params p = {.conn_mode = BLE_GAP_CONN_MODE_UND, .disc_mode = BLE_GAP_DISC_MODE_GEN,
                                   .itvl_min = 160, .itvl_max = 240};
    if (!e) e = ble_gap_adv_start(own_addr, NULL, BLE_HS_FOREVER, &p, gap_cb, NULL);
    if (e) ESP_LOGW("ble", "advertise error=%d", e);
}
static int gap_cb(struct ble_gap_event *event, void *arg) {
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (!event->connect.status) {
            atomic_store(&conn, event->connect.conn_handle);
            const struct ble_gap_upd_params p = {.itvl_min = 12, .itvl_max = 24, .latency = 0,
                /* A single-radio host can briefly suspend BLE while joining
                 * this board's 2.4 GHz AP. Do not revoke it after only 4 s. */
                                                 .supervision_timeout = 1200};
            ble_gap_update_params(event->connect.conn_handle, &p);
            ble_gap_set_data_len(event->connect.conn_handle, 251, 2120);
        } else advertise();
        break;
    case BLE_GAP_EVENT_CONN_UPDATE: {
        struct ble_gap_conn_desc d;
        if (!ble_gap_conn_find(event->conn_update.conn_handle, &d))
            ESP_LOGI("ble", "connection interval=%u latency=%u supervision=%u", d.conn_itvl, d.conn_latency, d.supervision_timeout);
        break;
    }
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI("ble", "disconnect reason=%d", event->disconnect.reason);
        atomic_store(&conn, BLE_HS_CONN_HANDLE_NONE);
        atomic_store(&tx_subscribed, false); atomic_store(&audio_subscribed, false);
        atomic_store(&indicate_status, BLE_HS_ENOTCONN); xSemaphoreGive(indication);
        incoming.id = 0; lj_capture_disconnect(); lj_control_disconnected(); advertise();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        ESP_LOGI("ble", "subscribe handle=%u notify=%u indicate=%u", event->subscribe.attr_handle, event->subscribe.cur_notify, event->subscribe.cur_indicate);
        if (event->subscribe.attr_handle == tx_handle) atomic_store(&tx_subscribed, event->subscribe.cur_indicate);
        if (event->subscribe.attr_handle == audio_handle) atomic_store(&audio_subscribed, event->subscribe.cur_notify);
        break;
    case BLE_GAP_EVENT_NOTIFY_TX:
        if (event->notify_tx.indication && event->notify_tx.status != 0) {
            ESP_LOGD("ble", "indication status=%d handle=%u", event->notify_tx.status, event->notify_tx.attr_handle);
            atomic_store(&indicate_status, event->notify_tx.status); xSemaphoreGive(indication);
        }
        break;
    case BLE_GAP_EVENT_ADV_COMPLETE: advertise(); break;
    default: break;
    }
    return 0;
}
static esp_err_t json_send(const cJSON *o, unsigned ack_ms) {
    if (!lj_ble_ready()) return ESP_ERR_INVALID_STATE;
    char *json = cJSON_PrintUnformatted(o);
    if (!json) return ESP_ERR_NO_MEM;
    size_t len = strlen(json), total = len + 8;
    unsigned cap = lj_ble_mtu() - 3; if (cap > 512) cap = 512;
    cap -= 6;
    unsigned count = (total + cap - 1) / cap;
    if (total > 48 * 1024 || count > 255) { free(json); return ESP_ERR_INVALID_SIZE; }
    xSemaphoreTake(json_mutex, portMAX_DELAY);
    if (!++frame_id) frame_id = 1;
    esp_err_t result = ESP_OK;
    uint8_t envelope[8] = {1,3,0,0,len,len >> 8,len >> 16,len >> 24};
    cJSON *error = cJSON_GetObjectItemCaseSensitive(o, "error");
    if (error && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(error, "retryable"))) envelope[2] = 2;
    for (unsigned i = 0; i < count; ++i) {
        uint8_t b[512]; size_t offset = i * cap, n = total - offset; if (n > cap) n = cap;
        b[0] = frame_id; b[1] = frame_id >> 8; b[2] = i; b[3] = count; b[4] = n; b[5] = n >> 8;
        for (size_t j = 0; j < n; ++j) b[6 + j] = offset + j < 8 ? envelope[offset + j] : json[offset + j - 8];
        while (xSemaphoreTake(indication, 0)) {}
        atomic_store(&indicate_status, 0);
        struct os_mbuf *mbuf = packet(&control_pool, b, n + 6);
        if (!mbuf) { result = ESP_ERR_NO_MEM; break; }
        int e = ble_gatts_indicate_custom(atomic_load(&conn), tx_handle, mbuf);
        bool ack = !e && xSemaphoreTake(indication, pdMS_TO_TICKS(ack_ms));
        if (e || !ack || atomic_load(&indicate_status) != BLE_HS_EDONE) {
            ESP_LOGW("ble", "control send failed rc=%d status=%d mtu=%u fragment=%u", e, atomic_load(&indicate_status), lj_ble_mtu(), i);
            if (!e && !ack && lj_ble_ready()) ble_gap_terminate(atomic_load(&conn), BLE_ERR_REM_USER_CONN_TERM);
            result = ESP_FAIL; break;
        }
    }
    xSemaphoreGive(json_mutex); free(json); return result;
}
esp_err_t lj_ble_json(const cJSON *o) { return json_send(o, 2500); }
esp_err_t lj_ble_key_request(const cJSON *o) { return json_send(o, 150); }
esp_err_t lj_ble_audio(uint8_t kind, bool final, uint32_t stream, uint32_t seq,
                        uint64_t offset, const void *pcm, size_t bytes, unsigned wait_ms) {
    if (bytes > lj_pcm_capacity(lj_ble_mtu()) || bytes % 2) return ESP_ERR_INVALID_SIZE;
    uint8_t b[512]; lj_audio_header(b, kind, final, stream, seq, offset);
    if (bytes) memcpy(b + 20, pcm, bytes);
    int64_t until = esp_timer_get_time() + (int64_t)wait_ms * 1000;
    do {
        if (!lj_ble_audio_ready()) return ESP_ERR_INVALID_STATE;
        struct os_mbuf *m = packet(&audio_pool, b, bytes + 20);
        int e = m ? ble_gatts_notify_custom(atomic_load(&conn), audio_handle, m) : BLE_HS_ENOMEM;
        if (!e) return ESP_OK;
        if (e != BLE_HS_ENOMEM && e != BLE_HS_EAGAIN && e != BLE_HS_EBUSY) return ESP_FAIL;
        vTaskDelay(pdMS_TO_TICKS(3));
    } while (esp_timer_get_time() < until);
    return ESP_ERR_TIMEOUT;
}
static void sync_cb(void) {
    if (!ble_hs_util_ensure_addr(0) && !ble_hs_id_infer_auto(0, &own_addr)) advertise();
}
static void host_task(void *unused) { (void)unused; nimble_port_run(); nimble_port_freertos_deinit(); }
esp_err_t lj_ble_init(void) {
    json_mutex = xSemaphoreCreateMutex(); indication = xSemaphoreCreateBinary();
    incoming.bytes = heap_caps_malloc(48 * 1024, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!json_mutex || !indication || !incoming.bytes) return ESP_ERR_NO_MEM;
    esp_err_t e = nimble_port_init(); if (e != ESP_OK) return e;
    void *audio_memory = heap_caps_malloc(OS_MEMPOOL_BYTES(12, 640), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    void *control_memory = heap_caps_malloc(OS_MEMPOOL_BYTES(4, 640), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!audio_memory || !control_memory) return ESP_ERR_NO_MEM;
    if (os_mempool_init(&audio_mem_pool, 12, 640, audio_memory, "lj-audio") ||
        os_mbuf_pool_init(&audio_pool, &audio_mem_pool, 640, 12) ||
        os_mempool_init(&control_mem_pool, 4, 640, control_memory, "lj-control") ||
        os_mbuf_pool_init(&control_pool, &control_mem_pool, 640, 4)) return ESP_FAIL;
    ble_hs_cfg.sync_cb = sync_cb;
    ble_svc_gap_init(); ble_svc_gatt_init(); ble_svc_gap_device_name_set("LaoJi Test Board");
    ble_att_set_preferred_mtu(517);
    if (ble_gatts_count_cfg(services) || ble_gatts_add_svcs(services)) return ESP_FAIL;
    nimble_port_freertos_init(host_task); return ESP_OK;
}
