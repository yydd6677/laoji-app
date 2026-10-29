#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Admission expiry and an already admitted request have distinct lifetimes.
 * An explicit close revokes both. No expired token may start another request. */
static inline bool lj_wifi_can_admit(bool active, int64_t now, int64_t deadline) {
    return active && now < deadline;
}
static inline bool lj_wifi_should_expire(bool active, unsigned requests, int64_t now, int64_t deadline) {
    return active && !requests && now >= deadline;
}
static inline bool lj_wifi_can_continue(bool active, bool admitted) {
    return active && admitted;
}
