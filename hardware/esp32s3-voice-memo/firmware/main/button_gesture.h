#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef enum { LJ_KEY_NONE, LJ_KEY_SHORT, LJ_KEY_DOUBLE, LJ_KEY_LONG } lj_key_event_t;
typedef struct {
    bool raw, stable, initialized, released, held, pending, second;
    int64_t changed, down, up;
} lj_key_state_t;
/* Active-low GPIO is normalized to pressed=true by the board adapter. */
lj_key_event_t lj_key_step(lj_key_state_t *s, bool pressed, int64_t now_us);
typedef enum { LJ_ACTION_NONE, LJ_ACTION_MEETING, LJ_ACTION_SCHEDULE, LJ_ACTION_STOP, LJ_ACTION_PAUSE, LJ_ACTION_RESUME } lj_key_action_t;
lj_key_action_t lj_key_action(lj_key_event_t event, bool active, bool paused, bool busy);
