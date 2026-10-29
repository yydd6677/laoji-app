#include "button_gesture.h"
#include <assert.h>
#include <stdio.h>
static lj_key_state_t s;
static long long now;
static unsigned counts[4];
static void step(bool down, unsigned ms) {
    for (unsigned i = 0; i < ms; i += 10) {
        now += 10000; lj_key_event_t e = lj_key_step(&s, down, now); ++counts[e];
    }
}
static void reset(bool held) { s = (lj_key_state_t){0}; now = 0; for(int i=0;i<4;i++) counts[i]=0; step(held, 60); }
int main(void) {
    reset(false); step(true,100); step(false,500); assert(counts[LJ_KEY_SHORT]==1);
    reset(false); step(true,100); step(false,100); step(true,100); step(false,500);
    assert(counts[LJ_KEY_DOUBLE]==1 && !counts[LJ_KEY_SHORT] && !counts[LJ_KEY_LONG]);
    reset(false); step(true,2000); assert(counts[LJ_KEY_LONG]==1); step(false,500);
    assert(!counts[LJ_KEY_SHORT] && !counts[LJ_KEY_DOUBLE]);
    reset(true); step(true,2000); assert(!counts[LJ_KEY_LONG]); step(false,500); assert(!counts[LJ_KEY_SHORT]);
    step(true,900); step(false,400); assert(counts[LJ_KEY_LONG]==1 && !counts[LJ_KEY_SHORT]);
    reset(false); for(int i=0;i<8;i++) { step(true,10); step(false,10); } step(false,500);
    assert(!counts[LJ_KEY_SHORT] && !counts[LJ_KEY_DOUBLE] && !counts[LJ_KEY_LONG]);
    for(int event=0;event<4;event++) for(int active=0;active<2;active++) for(int paused=0;paused<2;paused++) {
        assert(lj_key_action(event,active,paused,true)==LJ_ACTION_NONE);
        lj_key_action_t expected=active ? event==LJ_KEY_LONG ? LJ_ACTION_STOP : event==LJ_KEY_SHORT ?
            paused ? LJ_ACTION_RESUME : LJ_ACTION_PAUSE : LJ_ACTION_NONE :
            event==LJ_KEY_LONG ? LJ_ACTION_MEETING : event==LJ_KEY_DOUBLE ? LJ_ACTION_SCHEDULE : LJ_ACTION_NONE;
        assert(lj_key_action(event,active,paused,false)==expected);
    }
    puts("production gesture debounce, double, threshold, consumed release, boot guard and action matrix passed");
}
