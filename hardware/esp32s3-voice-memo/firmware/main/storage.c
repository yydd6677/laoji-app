#include "lj.h"
#include "metadata_index.h"
#include <dirent.h>
#include <errno.h>
#include <inttypes.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "esp_vfs_fat.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "sdmmc_cmd.h"
#include "driver/sdmmc_host.h"
#include "mbedtls/sha256.h"

SemaphoreHandle_t lj_fs_mutex;
static bool mounted;
static unsigned pins;
static struct { bool valid; time_t mtime; off_t size; lj_recording_t meta; } cache[16];
static unsigned next_cache;
#define HASH_BUFFER_BYTES 8192
/* All metadata readers hold lj_fs_mutex. Never reserve this bulk workspace on
 * a caller's stack: even a cache hit used to reserve an 8.5 KiB frame. */
static uint8_t *hash_buffer;
bool lj_reader_open(lj_reader_t *r, const char *path) {
    memset(r, 0, sizeof(*r));
    r->file = fopen(path, "rb"); if (!r->file) return false;
    /* Buffers passed to fread are not necessarily the buffers used by newlib
     * for disk I/O. Configure the FILE stream before its first read/seek. */
    for (size_t size = 16384; size >= 4096; size /= 2) {
        r->buffer = heap_caps_malloc(size, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
        if (!r->buffer) continue;
        if (!setvbuf(r->file, r->buffer, _IOFBF, size)) return true;
        free(r->buffer); r->buffer = NULL;
    }
    /* Low memory reduces throughput, never integrity or recording availability. */
    ESP_LOGW("storage", "reader using default buffering"); return true;
}
void lj_reader_close(lj_reader_t *r) {
    if (r->file) fclose(r->file);
    free(r->buffer); memset(r, 0, sizeof(*r));
}
#define INDEX_DIR LJ_DISK "/.laoji-meta"
static bool index_ready;

static void hex_digest(char out[72], const uint8_t digest[32]) {
    strcpy(out, "sha256:");
    for (unsigned i = 0; i < 32; ++i) snprintf(out + 7 + i * 2, 3, "%02x", digest[i]);
}
static bool parse_digest(const char *text, uint8_t out[32]) {
    if (strlen(text) != 71 || strncmp(text, "sha256:", 7)) return false;
    for (unsigned i = 0; i < 32; ++i) {
        unsigned value = 0;
        for (unsigned j = 0; j < 2; ++j) {
            char c = text[7 + i * 2 + j];
            unsigned n = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : 16;
            if (n > 15) return false;
            value = value * 16 + n;
        }
        out[i] = value;
    }
    return true;
}
static void index_path(const char *name, char out[LJ_PATH_MAX], uint8_t name_sha[32]) {
    mbedtls_sha256((const uint8_t *)name, strlen(name), name_sha, 0);
    char hex[72]; hex_digest(hex, name_sha);
    snprintf(out, LJ_PATH_MAX, INDEX_DIR "/%s.idx", hex + 7);
}
/* A persisted checksum is tied to the real file/header, never trusted by name
 * alone. External same-size/same-mtime payload edits still fail the receiver's
 * full SHA validation; this index is a cache, not an authenticity assertion. */
static bool index_load(const char *name, const struct stat *st, const uint8_t header[44], lj_recording_t *m) {
    if (!index_ready) return false;
    char path[LJ_PATH_MAX]; uint8_t name_sha[32], header_sha[32], bytes[LJ_INDEX_BYTES];
    index_path(name, path, name_sha);
    FILE *f = fopen(path, "rb"); if (!f) return false;
    bool exact = fread(bytes, 1, sizeof(bytes), f) == sizeof(bytes) && fgetc(f) == EOF;
    fclose(f);
    lj_index_record r;
    if (!exact || !lj_index_decode(bytes, sizeof(bytes), &r)) return false;
    mbedtls_sha256(header, 44, header_sha, 0);
    if (memcmp(r.name_sha, name_sha, 32) || memcmp(r.header_sha, header_sha, 32) || r.mtime != st->st_mtime ||
        r.file_bytes != m->file_bytes || r.data_offset != m->data_offset || r.audio_bytes != m->audio_bytes) return false;
    m->created_ms = r.created_ms; hex_digest(m->sha, r.audio_sha); return true;
}
static void index_save(const char *name, const struct stat *st, const uint8_t header[44], const lj_recording_t *m) {
    if (!index_ready) return;
    lj_index_record r = {.mtime = st->st_mtime, .created_ms = m->created_ms, .file_bytes = m->file_bytes,
        .data_offset = m->data_offset, .audio_bytes = m->audio_bytes};
    char path[LJ_PATH_MAX], temp[LJ_PATH_MAX + 5]; uint8_t bytes[LJ_INDEX_BYTES];
    index_path(name, path, r.name_sha); mbedtls_sha256(header, 44, r.header_sha, 0);
    if (!parse_digest(m->sha, r.audio_sha) || !lj_index_encode(&r, bytes)) return;
    snprintf(temp, sizeof(temp), "%s.part", path);
    FILE *f = fopen(temp, "wb"); if (!f) return;
    bool ok = fwrite(bytes, 1, sizeof(bytes), f) == sizeof(bytes) && !fflush(f) && !fsync(fileno(f));
    if (fclose(f)) ok = false;
    if (ok && rename(temp, path)) {
        /* Some FAT VFS implementations do not replace existing destinations.
         * A cut here loses only the optional index; audio is never touched. */
        if (errno == EEXIST && !unlink(path)) ok = !rename(temp, path); else ok = false;
    }
    if (!ok) { unlink(temp); ESP_LOGW("storage", "optional metadata index not saved"); }
}
void lj_storage_forget(const char *name) {
    if (!index_ready || !lj_safe_name(name)) return;
    char path[LJ_PATH_MAX], temp[LJ_PATH_MAX + 5]; uint8_t digest[32];
    index_path(name, path, digest); snprintf(temp, sizeof(temp), "%s.part", path);
    unlink(path); unlink(temp); lj_storage_invalidate();
}
static bool wav_name(const char *n) {
    size_t l = strlen(n);
    return lj_safe_name(n) && l > 4 && !strcasecmp(n + l - 4, ".wav");
}
esp_err_t lj_storage_init(void) {
    lj_fs_mutex = xSemaphoreCreateMutex();
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.max_freq_khz = SDMMC_FREQ_DEFAULT;
    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
    slot.width = 1; slot.clk = 21; slot.cmd = 47; slot.d0 = 14;
    slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
    const esp_vfs_fat_sdmmc_mount_config_t cfg = {.format_if_mount_failed = false,
        .max_files = 8, .allocation_unit_size = 16384};
    sdmmc_card_t *card;
    esp_err_t e = esp_vfs_fat_sdmmc_mount(LJ_DISK, &host, &slot, &cfg, &card);
    mounted = e == ESP_OK;
    if (mounted) {
        struct stat st;
        index_ready = (!mkdir(INDEX_DIR, 0700) || errno == EEXIST) && !stat(INDEX_DIR, &st) && S_ISDIR(st.st_mode);
    }
    if (mounted) hash_buffer = heap_caps_malloc(HASH_BUFFER_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    ESP_LOGI("storage", "mount=%s; formatting disabled", esp_err_to_name(e));
    return e;
}
bool lj_storage_ready(void) { return mounted; }
bool lj_storage_pinned(void) { return pins != 0; } /* caller owns fs mutex */
void lj_storage_pin(bool value) { if (value) ++pins; else if (pins) --pins; }
void lj_storage_invalidate(void) { memset(cache, 0, sizeof(cache)); }
esp_err_t lj_storage_committed(const char *name, uint32_t bytes, const char *sha, int64_t created, lj_recording_t *out) {
    char path[LJ_PATH_MAX]; struct stat st;
    snprintf(path, sizeof(path), LJ_DISK "/%s", name);
    if (stat(path, &st) || st.st_size != (off_t)bytes + LJ_CAPTURE_HEADER_BYTES) return ESP_FAIL;
    memset(out, 0, sizeof(*out));
    snprintf(out->name, sizeof(out->name), "%s", name); snprintf(out->sha, sizeof(out->sha), "%s", sha);
    snprintf(out->generation, sizeof(out->generation), "gen-%08" PRIx64 "-%08" PRIx64,
             (uint64_t)st.st_mtime, (uint64_t)st.st_size);
    out->data_offset = LJ_CAPTURE_HEADER_BYTES; out->audio_bytes = bytes; out->file_bytes = st.st_size; out->created_ms = created;
    uint8_t header[LJ_CAPTURE_HEADER_BYTES];
    FILE *f = fopen(path, "rb");
    if (!f) return ESP_FAIL;
    bool valid = fread(header, 1, sizeof(header), f) == sizeof(header) &&
        lj_context_decode(header + 44, LJ_CONTEXT_BYTES, &out->context);
    fclose(f); if (!valid) return ESP_FAIL;
    index_save(name, &st, header, out);
    unsigned idx = next_cache++ % 16;
    cache[idx].valid = true; cache[idx].size = st.st_size; cache[idx].mtime = st.st_mtime; cache[idx].meta = *out;
    return ESP_OK;
}
uint64_t lj_storage_free(void) {
    uint64_t total = 0, free = 0;
    if (mounted) esp_vfs_fat_info(LJ_DISK, &total, &free);
    return free;
}
unsigned lj_storage_count(void) {
    unsigned n = 0;
    if (!mounted) return n;
    DIR *d = opendir(LJ_DISK);
    if (!d) return n;
    struct dirent *e;
    while ((e = readdir(d))) if (wav_name(e->d_name)) ++n;
    closedir(d); return n;
}
cJSON *lj_storage_list(unsigned offset, unsigned limit, bool *more) {
    cJSON *a = cJSON_CreateArray();
    *more = false;
    if (!mounted) return a;
    DIR *d = opendir(LJ_DISK);
    if (!d) return a;
    unsigned seen = 0, kept = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!wav_name(e->d_name)) continue;
        if (seen++ < offset) continue;
        if (kept == limit) { *more = true; break; }
        cJSON_AddItemToArray(a, cJSON_CreateString(e->d_name)); ++kept;
    }
    closedir(d); return a;
}
/* Called with the fs mutex held. RIFF chunks are parsed, never assume data=44. */
static esp_err_t read_meta(const char *name, lj_recording_t *out, bool checksum) {
    if (!mounted || !wav_name(name)) return ESP_ERR_INVALID_ARG;
    char path[LJ_PATH_MAX]; snprintf(path, sizeof(path), LJ_DISK "/%s", name);
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode) || st.st_size < 44 || st.st_size > UINT32_MAX) return ESP_ERR_NOT_FOUND;
    for (unsigned i = 0; i < 16; ++i) {
        if (cache[i].valid && cache[i].mtime == st.st_mtime && cache[i].size == st.st_size && !strcmp(cache[i].meta.name, name)) {
            *out = cache[i].meta; return ESP_OK;
        }
    }
    if (checksum && !hash_buffer) return ESP_ERR_NO_MEM;
    lj_reader_t reader;
    if (!lj_reader_open(&reader, path)) return ESP_FAIL;
    FILE *f = reader.file;
    uint8_t h[24], source_header[44]; bool fmt = false, data = false;
    esp_err_t result = ESP_ERR_INVALID_RESPONSE;
    if (fread(source_header, 1, 44, f) != 44 || memcmp(source_header, "RIFF", 4) || memcmp(source_header + 8, "WAVE", 4)) goto done;
    memset(out, 0, sizeof(*out));
    uint32_t position = 12;
    while ((uint64_t)position + 8 <= (uint64_t)st.st_size) {
        if (fseek(f, position, SEEK_SET) || fread(h, 1, 8, f) != 8) goto done;
        uint32_t bytes = lj_u32(h + 4);
        if ((uint64_t)position + 8 + bytes > (uint64_t)st.st_size) goto done;
        if (!memcmp(h, "fmt ", 4)) {
            if (bytes < 16 || fread(h, 1, 16, f) != 16 || lj_u16(h) != 1 || lj_u16(h + 2) != 1 ||
                lj_u32(h + 4) != LJ_RATE || lj_u16(h + 12) != 2 || lj_u16(h + 14) != 16) goto done;
            fmt = true;
        } else if (!memcmp(h, "ljct", 4)) {
            uint8_t context[LJ_CONTEXT_BYTES];
            if (bytes != sizeof(context) || fread(context, 1, sizeof(context), f) != sizeof(context) ||
                !lj_context_decode(context, bytes, &out->context)) goto done;
        } else if (!memcmp(h, "data", 4)) {
            if (bytes % 2) goto done;
            out->data_offset = position + 8; out->audio_bytes = bytes; data = true;
        }
        uint64_t next = (uint64_t)position + 8 + bytes + (bytes & 1);
        if (next > UINT32_MAX) goto done;
        position = next;
    }
    if (!fmt || !data) goto done;
    snprintf(out->name, sizeof(out->name), "%s", name);
    snprintf(out->generation, sizeof(out->generation), "gen-%08" PRIx64 "-%08" PRIx64,
             (uint64_t)st.st_mtime, (uint64_t)st.st_size);
    out->file_bytes = st.st_size; out->created_ms = (int64_t)st.st_mtime * 1000;
    if (out->context.id[0]) out->created_ms = out->context.epoch_ms;
    out->recovered = !strncmp(name, "RECOVERED_", 10);
    if (!checksum) { result = ESP_OK; goto done; }
    if (index_load(name, &st, source_header, out)) {
        unsigned idx = next_cache++ % 16;
        cache[idx].valid = true; cache[idx].size = st.st_size; cache[idx].mtime = st.st_mtime; cache[idx].meta = *out;
        result = ESP_OK; goto done;
    }
    mbedtls_sha256_context sha; mbedtls_sha256_init(&sha); mbedtls_sha256_starts(&sha, 0);
    uint8_t digest[32];
    if (fseek(f, out->data_offset, SEEK_SET)) { mbedtls_sha256_free(&sha); goto done; }
    uint32_t left = out->audio_bytes;
    while (left) {
        size_t want = left < HASH_BUFFER_BYTES ? left : HASH_BUFFER_BYTES;
        if (fread(hash_buffer, 1, want, f) != want) { mbedtls_sha256_free(&sha); goto done; }
        mbedtls_sha256_update(&sha, hash_buffer, want); left -= want;
    }
    mbedtls_sha256_finish(&sha, digest); mbedtls_sha256_free(&sha);
    strcpy(out->sha, "sha256:");
    for (unsigned i = 0; i < 32; ++i) snprintf(out->sha + 7 + i * 2, 3, "%02x", digest[i]);
    index_save(name, &st, source_header, out);
    unsigned idx = next_cache++ % 16;
    cache[idx].valid = true; cache[idx].size = st.st_size; cache[idx].mtime = st.st_mtime; cache[idx].meta = *out;
    result = ESP_OK;
done:
    lj_reader_close(&reader); return result;
}
esp_err_t lj_storage_meta(const char *name, lj_recording_t *out) { return read_meta(name, out, true); }
/* A list preview never scans PCM and is never a transfer integrity contract. */
cJSON *lj_storage_preview(const char *name) {
    lj_recording_t m;
    if (read_meta(name, &m, false) != ESP_OK) return NULL;
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "recording_id", m.name);
    cJSON_AddStringToObject(o, "generation", m.generation);
    cJSON_AddNumberToObject(o, "file_bytes", m.file_bytes);
    cJSON_AddNumberToObject(o, "duration_ms", (uint64_t)m.audio_bytes * 1000 / LJ_BYTES_PER_SECOND);
    cJSON_AddNumberToObject(o, "created_epoch_ms", m.created_ms);
    cJSON_AddStringToObject(o, "purpose", m.context.schedule ? "schedule" : "meeting");
    cJSON_AddStringToObject(o, "capture_id", m.context.id);
    return o;
}
cJSON *lj_audio_json(void) {
    cJSON *a = cJSON_CreateObject();
    cJSON_AddStringToObject(a, "codec", "pcm_s16le"); cJSON_AddNumberToObject(a, "sample_rate_hz", LJ_RATE);
    cJSON_AddNumberToObject(a, "channels", 1); cJSON_AddNumberToObject(a, "bits_per_sample", 16);
    cJSON_AddBoolToObject(a, "local_storage", true); return a;
}
cJSON *lj_recording_json(const lj_recording_t *m) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "recording_id", m->name); cJSON_AddStringToObject(o, "generation", m->generation);
    cJSON_AddStringToObject(o, "container", "wav"); cJSON_AddItemToObject(o, "audio", lj_audio_json());
    cJSON_AddNumberToObject(o, "audio_bytes", m->audio_bytes); cJSON_AddNumberToObject(o, "file_bytes", m->file_bytes);
    cJSON_AddNumberToObject(o, "samples", m->audio_bytes / 2);
    cJSON_AddNumberToObject(o, "duration_ms", (uint64_t)m->audio_bytes * 1000 / LJ_BYTES_PER_SECOND);
    cJSON_AddStringToObject(o, "checksum_sha256", m->sha); cJSON_AddStringToObject(o, "checksum_scope", "audio_payload");
    cJSON_AddNumberToObject(o, "created_epoch_ms", m->created_ms); cJSON_AddBoolToObject(o, "recovered", m->recovered);
    cJSON_AddStringToObject(o, "purpose", m->context.schedule ? "schedule" : "meeting");
    cJSON_AddStringToObject(o, "capture_id", m->context.id);
    cJSON_AddStringToObject(o, "time_zone", m->context.timezone);
    return o;
}
void lj_storage_recover(void) {
    if (!mounted) return;
    DIR *d = opendir(LJ_DISK); if (!d) return;
    struct dirent *e;
    while ((e = readdir(d))) {
        size_t len = strlen(e->d_name);
        if (len < 10 || strncmp(e->d_name, "LJ_", 3) || strcmp(e->d_name + len - 9, ".wav.part")) continue;
        char path[LJ_PATH_MAX], target[LJ_PATH_MAX], name[LJ_NAME_MAX + 1];
        if (len > LJ_NAME_MAX - 10) continue;
        snprintf(path, sizeof(path), LJ_DISK "/%.120s", e->d_name);
        struct stat st;
        if (stat(path, &st) || st.st_size < 46 || st.st_size > UINT32_MAX - 36) continue;
        FILE *f = fopen(path, "rb+"); if (!f) continue;
        uint8_t h[LJ_CAPTURE_HEADER_BYTES];
        /* Recover only our own canonical RIFF layout, never arbitrary user files. */
        size_t got = fread(h, 1, sizeof(h), f);
        if (got < 44 || memcmp(h, "RIFF", 4)) { fclose(f); continue; }
        lj_capture_context_t context;
        unsigned header = !memcmp(h + 36, "data", 4) ? 44 :
            got == sizeof(h) && !memcmp(h + 36, "ljct", 4) &&
            lj_context_decode(h + 44, LJ_CONTEXT_BYTES, &context) && !memcmp(h + 216, "data", 4) ? sizeof(h) : 0;
        if (!header || st.st_size < header + 2) { fclose(f); continue; }
        uint32_t bytes = ((uint32_t)st.st_size - header) & ~1u;
        if (header == 44) lj_wav_header(h, bytes); else lj_context_header(h, bytes, &context);
        bool ok = !fseek(f, 0, SEEK_SET) && fwrite(h, 1, header, f) == header && !fflush(f) &&
                  !ftruncate(fileno(f), bytes + header) && !fsync(fileno(f));
        fclose(f);
        snprintf(name, sizeof(name), "RECOVERED_%.*s", (int)len - 5, e->d_name);
        snprintf(target, sizeof(target), LJ_DISK "/%s", name);
        if (ok && access(target, F_OK)) rename(path, target);
    }
    closedir(d);
}
