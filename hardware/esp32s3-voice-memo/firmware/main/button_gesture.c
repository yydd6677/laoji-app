#include "button_gesture.h"
#define DEBOUNCE 40000
#define DOUBLE 320000
#define LONG 800000
lj_key_action_t lj_key_action(lj_key_event_t event, bool active, bool paused, bool busy) {
    if (busy) return LJ_ACTION_NONE;
    if (active) return event == LJ_KEY_LONG ? LJ_ACTION_STOP : event == LJ_KEY_SHORT ?
        paused ? LJ_ACTION_RESUME : LJ_ACTION_PAUSE : LJ_ACTION_NONE;
    return event == LJ_KEY_LONG ? LJ_ACTION_MEETING : event == LJ_KEY_DOUBLE ? LJ_ACTION_SCHEDULE : LJ_ACTION_NONE;
}
lj_key_event_t lj_key_step(lj_key_state_t *s, bool pressed, int64_t now) {
    if (!s->initialized) {
        s->initialized = true; s->raw = s->stable = pressed;
        s->changed = now; s->released = !pressed;
        return LJ_KEY_NONE; /* A button held during boot never starts capture. */
    }
    if (pressed != s->raw) { s->raw = pressed; s->changed = now; }
    if (now - s->changed >= DEBOUNCE && s->stable != s->raw) {
        s->stable = s->raw;
        if (s->stable) {
            s->down = now; s->held = false;
            s->second = s->pending && now - s->up <= DOUBLE + DEBOUNCE;
            if (s->second) s->pending = false;
        } else {
            if (!s->released) { s->released = true; return LJ_KEY_NONE; }
            if (!s->held) {
                if (s->second) { s->second = false; return LJ_KEY_DOUBLE; }
                s->pending = true; s->up = now;
            }
        }
    }
    if (!s->released) return LJ_KEY_NONE;
    if (s->stable && !s->held && now - s->down >= LONG) {
        s->held = true; s->pending = s->second = false; return LJ_KEY_LONG;
    }
    if (s->pending && !s->stable && !s->raw && now - s->up > DOUBLE) {
        s->pending = false; return LJ_KEY_SHORT;
    }
    return LJ_KEY_NONE;
}
