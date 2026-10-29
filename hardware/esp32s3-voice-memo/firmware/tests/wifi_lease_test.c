#include "wifi_lease.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    assert(lj_wifi_can_admit(true, 119999999, 120000000));
    assert(!lj_wifi_can_admit(true, 120000000, 120000000));
    assert(!lj_wifi_can_admit(true, 130000000, 120000000));
    assert(!lj_wifi_can_admit(false, 0, 120000000));
    assert(lj_wifi_can_continue(true, true)); /* admitted work may finish */
    assert(!lj_wifi_can_continue(false, true)); /* explicit close interrupts */
    assert(!lj_wifi_can_continue(true, false));
    assert(!lj_wifi_should_expire(true, 1, 130000000, 120000000));
    assert(lj_wifi_should_expire(true, 0, 130000000, 120000000));
    assert(!lj_wifi_should_expire(false, 0, 130000000, 120000000));
    assert(!lj_wifi_should_expire(true, 0, 130000000, 240000000)); /* stale event after renewed offer */
    puts("Wi-Fi admission/expiry/explicit-revocation policy passed");
}
