#include "capture_context.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
int main(void) {
    lj_capture_context_t c={.schedule=true,.epoch_ms=1792800000000LL};
    strcpy(c.id,"capture-immutable-id");strcpy(c.timezone,"Asia/Shanghai");
    uint8_t h[LJ_CAPTURE_HEADER_BYTES]; lj_context_header(h,32000,&c);
    assert(!memcmp(h,"RIFF",4)&&!memcmp(h+36,"ljct",4)&&!memcmp(h+216,"data",4));
    lj_capture_context_t d;
    assert(lj_context_decode(h+44,LJ_CONTEXT_BYTES,&d));
    assert(d.schedule && d.epoch_ms==c.epoch_ms && !strcmp(d.id,c.id)&&!strcmp(d.timezone,c.timezone));
    lj_context_header(h,0,&d); assert(lj_context_decode(h+44,LJ_CONTEXT_BYTES,&d));
    h[45]=2;assert(!lj_context_decode(h+44,LJ_CONTEXT_BYTES,&d));
    lj_context_header(h,2,&c);memset(h+120,'x',96);assert(!lj_context_decode(h+44,LJ_CONTEXT_BYTES,&d));
    c.epoch_ms=0;c.timezone[0]=0;lj_context_header(h,0,&c);
    assert(lj_context_decode(h+44,LJ_CONTEXT_BYTES,&d)&&d.epoch_ms==0&&!d.timezone[0]);
    puts("production RIFF context encoding, stable identity, clock absence and invalid data passed");
}
