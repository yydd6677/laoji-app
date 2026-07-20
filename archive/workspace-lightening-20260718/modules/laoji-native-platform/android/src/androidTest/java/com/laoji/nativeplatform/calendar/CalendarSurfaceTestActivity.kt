package com.laoji.nativeplatform.calendar

// CAL-DAY-PAGER-001 / CAL-MONTH-EXPAND-001: isolated Android fixture host for source-derived tests.

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.view.MotionEvent
import android.widget.FrameLayout

class CalendarSurfaceTestActivity : Activity() {
  lateinit var root: TrackingRootLayout
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    root = TrackingRootLayout(this)
    setContentView(root)
  }
}

class TrackingRootLayout(context: Context) : FrameLayout(context) {
  private val touchActions = mutableListOf<String>()

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (touchActions.size < 24) {
      touchActions += "${event.actionMasked}@${event.x},${event.y}"
    }
    return super.dispatchTouchEvent(event)
  }

  fun resetTouchTrace() {
    touchActions.clear()
  }

  fun touchTrace(): String = touchActions.joinToString(" -> ")
}
