package com.laoji.nativeplatform.media

// MIN-PLAYER-001: MediaSessionService preserves playback and system controls off-screen.

import android.app.PendingIntent
import android.os.Bundle
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * System-owned playback boundary for [MIN_PLAYER_EVIDENCE_ID].
 *
 * Media3 publishes this session to lock-screen controls and maintains the foreground media
 * notification. The default task-removal policy intentionally keeps an ongoing recording alive.
 */
@UnstableApi
class LaojiMinutesPlaybackService : MediaSessionService() {
  private var playerAdapter: Media3MinutesPlayerAdapter? = null
  private var mediaSession: MediaSession? = null
  private lateinit var scopeStore: MinutesPlaybackScopeStore

  override fun onCreate() {
    super.onCreate()
    // Connecting the app or restoring a saved position must not publish a
    // system media notification before the user starts playback.
    setShowNotificationForIdlePlayer(MediaSessionService.SHOW_NOTIFICATION_FOR_IDLE_PLAYER_NEVER)
    scopeStore = MinutesPlaybackScopeStore(this)
    val adapter = Media3MinutesPlayerAdapter(
      context = this,
      initialStorageScope = scopeStore.activeScope(),
    )
    playerAdapter = adapter

    val builder = MediaSession.Builder(this, adapter.sessionPlayer)
      .setId(MINUTES_MEDIA_SESSION_ID)
      .setCallback(SessionCallback(adapter))
      .setMediaButtonPreferences(mediaButtonPreferences())

    packageManager.getLaunchIntentForPackage(packageName)?.let { launchIntent ->
      builder.setSessionActivity(
        PendingIntent.getActivity(
          this,
          0,
          launchIntent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
    }
    mediaSession = builder.build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

  override fun onDestroy() {
    mediaSession?.release()
    mediaSession = null
    playerAdapter?.release()
    playerAdapter = null
    super.onDestroy()
  }

  private inner class SessionCallback(
    private val adapter: Media3MinutesPlayerAdapter,
  ) : MediaSession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): MediaSession.ConnectionResult {
      if (controller.packageName != packageName && !controller.isTrusted) {
        return MediaSession.ConnectionResult.reject()
      }
      val builder = MediaSession.ConnectionResult.AcceptedResultBuilder(session)
      if (controller.packageName == packageName) {
        builder.setAvailableSessionCommands(
          MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
            .buildUpon()
            .add(MINUTES_SET_SOURCE_COMMAND)
            .add(MINUTES_CLEAR_SOURCE_COMMAND)
            .add(MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND)
            .build(),
        )
      }
      return builder.build()
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      if (controller.packageName != packageName) {
        return sessionResult(SessionResult.RESULT_ERROR_PERMISSION_DENIED)
      }
      return when (customCommand.customAction) {
        MINUTES_SET_SOURCE_ACTION -> {
          val source = args.toMinutesPlayerSource()
            ?: return sessionResult(SessionResult.RESULT_ERROR_BAD_VALUE)
          sessionResult(
            if (adapter.setSourceChecked(source)) {
              SessionResult.RESULT_SUCCESS
            } else {
              SessionResult.RESULT_ERROR_BAD_VALUE
            },
          )
        }

        MINUTES_CLEAR_SOURCE_ACTION -> {
          adapter.setSource(null)
          sessionResult(SessionResult.RESULT_SUCCESS)
        }

        MINUTES_ACTIVATE_STORAGE_SCOPE_ACTION -> {
          val scope = args.toMinutesStorageScope()
            ?: return sessionResult(SessionResult.RESULT_ERROR_BAD_VALUE)
          try {
            scopeStore.activate(scope)
            adapter.activateStorageScope(scope)
            sessionResult(SessionResult.RESULT_SUCCESS)
          } catch (_: Exception) {
            adapter.activateStorageScope(MINUTES_SIGNED_OUT_SCOPE)
            sessionResult(SessionResult.RESULT_ERROR_UNKNOWN)
          }
        }

        else -> sessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED)
      }
    }
  }

  private fun mediaButtonPreferences(): List<CommandButton> = listOf(
    CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15)
      .setDisplayName("后退 15 秒")
      .setPlayerCommand(Player.COMMAND_SEEK_BACK)
      .setSlots(CommandButton.SLOT_BACK)
      .build(),
    CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_15)
      .setDisplayName("前进 15 秒")
      .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
      .setSlots(CommandButton.SLOT_FORWARD)
      .build(),
  )

  private fun sessionResult(code: Int): ListenableFuture<SessionResult> =
    Futures.immediateFuture(SessionResult(code))
}
