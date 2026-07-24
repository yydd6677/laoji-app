package com.laoji.nativeplatform.entry

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.view.View
import android.widget.RemoteViews
import com.laoji.nativeplatform.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class LaojiUpcomingEventsWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
    update(context, manager, appWidgetIds)
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: android.os.Bundle,
  ) {
    update(context, manager, intArrayOf(appWidgetId))
  }

  companion object {
    fun update(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
      val nowMs = System.currentTimeMillis()
      val snapshot = SystemEntryProjectionStore.read(context, nowMs)
      val visibleEvents = snapshot.projection?.events.orEmpty().filter { it.endAtMs > nowMs }
      for (appWidgetId in appWidgetIds) {
        val views = RemoteViews(context.packageName, R.layout.laoji_widget_upcoming_events)
        val now = Date(nowMs)
        views.setTextViewText(
          R.id.laoji_widget_weekday,
          SimpleDateFormat("EEE", Locale.SIMPLIFIED_CHINESE).format(now),
        )
        views.setTextViewText(
          R.id.laoji_widget_day,
          SimpleDateFormat("d", Locale.SIMPLIFIED_CHINESE).format(now),
        )
        views.setOnClickPendingIntent(R.id.laoji_widget_root, appLaunchPendingIntent(context, appWidgetId))

        val showList = snapshot.fresh && visibleEvents.isNotEmpty()
        views.setViewVisibility(R.id.laoji_widget_event_list, if (showList) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.laoji_widget_state, if (showList) View.GONE else View.VISIBLE)
        views.setTextViewText(
          R.id.laoji_widget_state,
          context.getString(if (!snapshot.fresh) R.string.laoji_widget_stale else R.string.laoji_widget_empty),
        )
        if (showList) {
          val serviceIntent = Intent(context, UpcomingEventsRemoteViewsService::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .setData(Uri.parse("laoji-widget://upcoming/$appWidgetId/$nowMs"))
          views.setRemoteAdapter(R.id.laoji_widget_event_list, serviceIntent)
          views.setPendingIntentTemplate(
            R.id.laoji_widget_event_list,
            semanticLinkTemplate(context, appWidgetId),
          )
        }
        manager.updateAppWidget(appWidgetId, views)
        if (showList) manager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.laoji_widget_event_list)
      }
    }

    private fun appLaunchPendingIntent(context: Context, requestCode: Int): PendingIntent {
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: Intent(Intent.ACTION_MAIN).setClassName(context.packageName, "${context.packageName}.MainActivity")
      intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      return PendingIntent.getActivity(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag(),
      )
    }

    private fun semanticLinkTemplate(context: Context, requestCode: Int): PendingIntent {
      val intent = Intent(Intent.ACTION_VIEW)
        .setClassName(context.packageName, "${context.packageName}.MainActivity")
        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      val mutableFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
      return PendingIntent.getActivity(
        context,
        10_000 + requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or mutableFlag,
      )
    }

    private fun immutableFlag(): Int =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
  }
}
