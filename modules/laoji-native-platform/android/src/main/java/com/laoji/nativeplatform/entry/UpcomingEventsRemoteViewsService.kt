package com.laoji.nativeplatform.entry

import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import com.laoji.nativeplatform.R
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

class UpcomingEventsRemoteViewsService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = UpcomingEventsFactory(this)
}

private class UpcomingEventsFactory(
  private val context: android.content.Context,
) : RemoteViewsService.RemoteViewsFactory {
  private var projection: UpcomingEventsProjection? = null
  private var events: List<UpcomingEventProjectionItem> = emptyList()

  override fun onCreate() = reload()

  override fun onDataSetChanged() = reload()

  override fun onDestroy() {
    projection = null
    events = emptyList()
  }

  override fun getCount(): Int = events.size

  override fun getViewAt(position: Int): RemoteViews? {
    val event = events.getOrNull(position) ?: return null
    val views = RemoteViews(context.packageName, R.layout.laoji_widget_upcoming_event_item)
    views.setTextViewText(
      R.id.laoji_widget_event_title,
      if (projection?.hideTitles == true) "(标题已隐藏)" else event.title,
    )
    views.setTextViewText(R.id.laoji_widget_event_time, displayTime(event))
    views.setTextViewText(R.id.laoji_widget_event_action, event.meetingAction.label)
    views.setOnClickFillInIntent(
      R.id.laoji_widget_event_root,
      semanticIntent(event, action = "open"),
    )
    views.setOnClickFillInIntent(
      R.id.laoji_widget_event_action,
      semanticIntent(event, action = "meeting"),
    )
    return views
  }

  override fun getLoadingView(): RemoteViews =
    RemoteViews(context.packageName, R.layout.laoji_widget_loading_item)

  override fun getViewTypeCount(): Int = 1

  override fun getItemId(position: Int): Long {
    val event = events.getOrNull(position) ?: return position.toLong()
    return "${event.sourceEventId}:${event.occurrenceDate}".hashCode().toLong()
  }

  override fun hasStableIds(): Boolean = true

  private fun reload() {
    val nowMs = System.currentTimeMillis()
    val snapshot = SystemEntryProjectionStore.read(context, nowMs)
    projection = snapshot.projection.takeIf { snapshot.fresh }
    events = projection?.events.orEmpty().filter { it.endAtMs > nowMs }.take(5)
  }

  private fun semanticIntent(event: UpcomingEventProjectionItem, action: String): Intent {
    val data = Uri.Builder()
      .scheme("laoji")
      .authority("calendar")
      .appendPath("occurrence")
      .appendQueryParameter("sourceEventId", event.sourceEventId)
      .appendQueryParameter("occurrenceDate", event.occurrenceDate)
      .appendQueryParameter("action", action)
      .appendQueryParameter("origin", "widget")
      .build()
    return Intent(Intent.ACTION_VIEW).setData(data)
  }

  private fun displayTime(event: UpcomingEventProjectionItem): String {
    if (event.allDay) return "全天"
    val now = Calendar.getInstance()
    val start = Calendar.getInstance().apply { timeInMillis = event.startAtMs }
    val prefix = when {
      sameDay(now, start) -> ""
      isTomorrow(now, start) -> "明天 "
      else -> SimpleDateFormat("M月d日 ", Locale.SIMPLIFIED_CHINESE).format(Date(event.startAtMs))
    }
    val time = SimpleDateFormat("HH:mm", Locale.SIMPLIFIED_CHINESE).format(Date(event.startAtMs))
    return prefix + time
  }

  private fun sameDay(left: Calendar, right: Calendar): Boolean =
    left.get(Calendar.ERA) == right.get(Calendar.ERA) &&
      left.get(Calendar.YEAR) == right.get(Calendar.YEAR) &&
      left.get(Calendar.DAY_OF_YEAR) == right.get(Calendar.DAY_OF_YEAR)

  private fun isTomorrow(now: Calendar, candidate: Calendar): Boolean {
    val tomorrow = (now.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, 1) }
    return sameDay(tomorrow, candidate)
  }
}
