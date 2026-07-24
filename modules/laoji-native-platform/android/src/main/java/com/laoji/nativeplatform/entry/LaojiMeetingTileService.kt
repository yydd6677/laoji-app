package com.laoji.nativeplatform.entry

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.laoji.nativeplatform.audio.RecorderServiceClient

class LaojiMeetingTileService : TileService() {
  override fun onTileAdded() {
    super.onTileAdded()
    renderState()
  }

  override fun onStartListening() {
    super.onStartListening()
    renderState()
  }

  override fun onClick() {
    super.onClick()
    val intent = Intent(Intent.ACTION_VIEW)
      .setClassName(packageName, "$packageName.MainActivity")
      .setData(Uri.parse(QUICK_TILE_LINK))
      .addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_CLEAR_TOP or
          Intent.FLAG_ACTIVITY_SINGLE_TOP,
      )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val pendingIntent = PendingIntent.getActivity(
        this,
        QUICK_TILE_REQUEST_CODE,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      startActivityAndCollapse(pendingIntent)
    } else {
      @Suppress("DEPRECATION")
      startActivityAndCollapse(intent)
    }
  }

  private fun renderState() {
    val tile = qsTile ?: return
    val active = isMeetingRecordingActive()
    tile.label = "会议录音"
    tile.state = if (active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      tile.subtitle = if (active) "录音中" else "开始记录"
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      tile.stateDescription = if (active) "会议正在录音" else "会议录音未开始"
    }
    tile.updateTile()
  }

  companion object {
    const val QUICK_TILE_LINK = "laoji://meeting/new?origin=quick_tile"
    private const val QUICK_TILE_REQUEST_CODE = 27_104

    fun requestRefresh(context: Context) {
      runCatching {
        TileService.requestListeningState(
          context.applicationContext,
          ComponentName(context, LaojiMeetingTileService::class.java),
        )
      }
    }

    fun isMeetingRecordingActive(): Boolean {
      val sessionId = RecorderServiceClient.currentSessionId() ?: return false
      val snapshot = RecorderServiceClient.currentSnapshot(sessionId) ?: return false
      return snapshot.purpose.wireValue == "meeting" &&
        snapshot.state.wireValue in setOf("preparing", "recording", "paused")
    }
  }
}
