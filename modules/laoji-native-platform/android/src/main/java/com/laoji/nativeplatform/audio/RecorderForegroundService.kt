package com.laoji.nativeplatform.audio

// MIN-REC-STATE-001 / MIN-AUDIO-001: foreground service owns recording beyond route lifetime.

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.laoji.nativeplatform.entry.LaojiMeetingTileService
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

private const val NOTIFICATION_CHANNEL_ID = "laoji_native_recorder"
private const val NOTIFICATION_ID = 19_721
private const val EXTRA_REQUEST_ID = "com.laoji.nativeplatform.audio.REQUEST_ID"

internal sealed class RecorderServiceCommand(open val requestId: String) {
  data class Start(
    override val requestId: String,
    val config: RecorderStartConfig,
    val future: CompletableFuture<RecorderSnapshot>,
  ) : RecorderServiceCommand(requestId)

  data class Pause(
    override val requestId: String,
    val sessionId: String,
    val future: CompletableFuture<RecorderSnapshot>,
  ) : RecorderServiceCommand(requestId)

  data class Resume(
    override val requestId: String,
    val sessionId: String,
    val future: CompletableFuture<RecorderSnapshot>,
  ) : RecorderServiceCommand(requestId)

  data class Stop(
    override val requestId: String,
    val sessionId: String,
    val future: CompletableFuture<RecorderStopResult>,
  ) : RecorderServiceCommand(requestId)
}

object RecorderServiceClient {
  private val lock = Any()
  private val commands = ConcurrentHashMap<String, RecorderServiceCommand>()

  @Volatile
  private var activeSessionId: String? = null

  @Volatile
  private var latestSnapshot: RecorderSnapshot? = null

  fun start(context: Context, config: RecorderStartConfig): CompletableFuture<RecorderSnapshot> {
    val future = CompletableFuture<RecorderSnapshot>()
    synchronized(lock) {
      val active = activeSessionId
      if (active != null) {
        future.completeExceptionally(
          RecorderRuntimeException(
            RecorderErrorCode.SESSION_BUSY,
            "microphone is already owned by recording session $active",
          ),
        )
        return future
      }
      activeSessionId = config.sessionId
    }
    val requestId = requestId()
    val command = RecorderServiceCommand.Start(requestId, config, future)
    if (!dispatch(context, command, foreground = true)) {
      release(config.sessionId)
      future.completeExceptionally(
        RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "unable to start recording service"),
      )
    }
    return future
  }

  fun pause(context: Context, sessionId: String): CompletableFuture<RecorderSnapshot> {
    val future = CompletableFuture<RecorderSnapshot>()
    if (!owns(sessionId, future)) return future
    val requestId = requestId()
    val command = RecorderServiceCommand.Pause(requestId, sessionId, future)
    if (!dispatch(context, command, foreground = false)) {
      future.completeExceptionally(
        RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "unable to contact recording service"),
      )
    }
    return future
  }

  fun resume(context: Context, sessionId: String): CompletableFuture<RecorderSnapshot> {
    val future = CompletableFuture<RecorderSnapshot>()
    if (!owns(sessionId, future)) return future
    val requestId = requestId()
    val command = RecorderServiceCommand.Resume(requestId, sessionId, future)
    if (!dispatch(context, command, foreground = false)) {
      future.completeExceptionally(
        RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "unable to contact recording service"),
      )
    }
    return future
  }

  fun stop(context: Context, sessionId: String): CompletableFuture<RecorderStopResult> {
    val future = CompletableFuture<RecorderStopResult>()
    if (!owns(sessionId, future)) return future
    val requestId = requestId()
    val command = RecorderServiceCommand.Stop(requestId, sessionId, future)
    if (!dispatch(context, command, foreground = false)) {
      future.completeExceptionally(
        RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "unable to contact recording service"),
      )
    }
    return future
  }

  fun currentSnapshot(sessionId: String? = null): RecorderSnapshot? {
    val snapshot = latestSnapshot ?: return null
    return if (sessionId == null || snapshot.sessionId == sessionId) snapshot else null
  }

  fun currentSessionId(): String? = activeSessionId

  internal fun take(requestId: String): RecorderServiceCommand? = commands.remove(requestId)

  internal fun publish(snapshot: RecorderSnapshot) {
    latestSnapshot = snapshot
  }

  internal fun release(sessionId: String) {
    synchronized(lock) {
      if (activeSessionId == sessionId) activeSessionId = null
    }
  }

  private fun dispatch(
    context: Context,
    command: RecorderServiceCommand,
    foreground: Boolean,
  ): Boolean {
    commands[command.requestId] = command
    val intent = Intent(context.applicationContext, LaojiRecordingService::class.java)
      .setAction(command.javaClass.simpleName)
      .putExtra(EXTRA_REQUEST_ID, command.requestId)
    return try {
      if (foreground && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.applicationContext.startForegroundService(intent)
      } else {
        context.applicationContext.startService(intent)
      }
      true
    } catch (_: Exception) {
      commands.remove(command.requestId)
      false
    }
  }

  private fun <T> owns(sessionId: String, future: CompletableFuture<T>): Boolean {
    val active = activeSessionId
    if (active == sessionId) return true
    future.completeExceptionally(
      RecorderRuntimeException(
        RecorderErrorCode.SESSION_MISMATCH,
        if (active == null) "there is no active recording session" else "active recording session does not match",
      ),
    )
    return false
  }

  private fun requestId(): String = UUID.randomUUID().toString()
}

class LaojiRecordingService : Service(), RecorderEngineHost {
  private var engine: RecorderEngine? = null
  private var foregroundStarted = false
  private var stoppingNormally = false

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    RecorderRecovery.recover(this, RecorderServiceClient.currentSessionId())
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val requestId = intent?.getStringExtra(EXTRA_REQUEST_ID)
    val command = requestId?.let(RecorderServiceClient::take)
    if (command == null) {
      stopSelf(startId)
      return START_NOT_STICKY
    }
    when (command) {
      is RecorderServiceCommand.Start -> handleStart(command, startId)
      is RecorderServiceCommand.Pause -> handlePause(command)
      is RecorderServiceCommand.Resume -> handleResume(command)
      is RecorderServiceCommand.Stop -> handleStop(command)
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    val activeEngine = engine
    if (!stoppingNormally && activeEngine != null) {
      activeEngine.shutdownForServiceDestroy()
      RecorderServiceClient.release(activeEngine.sessionId)
    }
    engine = null
    LaojiMeetingTileService.requestRefresh(this)
    super.onDestroy()
  }

  override fun onSnapshotChanged(snapshot: RecorderSnapshot) {
    RecorderServiceClient.publish(snapshot)
    LaojiMeetingTileService.requestRefresh(this)
    if (foregroundStarted) {
      try {
        getSystemService(NotificationManager::class.java).notify(
          NOTIFICATION_ID,
          buildNotification(snapshot.state, snapshot.mode),
        )
      } catch (_: Exception) {
        // A notification refresh failure must not stop active microphone capture.
      }
    }
  }

  override fun onUnexpectedStop(result: RecorderStopResult) {
    RecorderServiceClient.release(result.snapshot.sessionId)
    LaojiMeetingTileService.requestRefresh(this)
    stoppingNormally = true
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun handleStart(command: RecorderServiceCommand.Start, startId: Int) {
    try {
      if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        throw RecorderRuntimeException(RecorderErrorCode.PERMISSION_DENIED, "microphone permission is required")
      }
      ensureForeground(RecorderState.PREPARING, command.config.mode)
      if (engine != null) {
        throw RecorderRuntimeException(RecorderErrorCode.SESSION_BUSY, "recording service already has a session")
      }
      val createdEngine = RecorderEngine(this, command.config, RecordingRepository(this), this)
      engine = createdEngine
      createdEngine.start().whenComplete { snapshot, error ->
        if (error != null) {
          val failure = publicFailure(error)
          command.future.completeExceptionally(failure)
          RecorderServiceClient.release(command.config.sessionId)
          LaojiMeetingTileService.requestRefresh(this)
          stoppingNormally = true
          stopForeground(STOP_FOREGROUND_REMOVE)
          stopSelf(startId)
        } else {
          command.future.complete(snapshot)
        }
      }
    } catch (error: Exception) {
      val failure = publicFailure(error)
      command.future.completeExceptionally(failure)
      RecorderServiceClient.release(command.config.sessionId)
      LaojiMeetingTileService.requestRefresh(this)
      stoppingNormally = true
      if (foregroundStarted) stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf(startId)
    }
  }

  private fun handlePause(command: RecorderServiceCommand.Pause) {
    val current = matchingEngine(command.sessionId, command.future) ?: return
    current.pause().whenComplete { snapshot, error ->
      if (error != null) command.future.completeExceptionally(publicFailure(error))
      else command.future.complete(snapshot)
    }
  }

  private fun handleResume(command: RecorderServiceCommand.Resume) {
    val current = matchingEngine(command.sessionId, command.future) ?: return
    current.resume().whenComplete { snapshot, error ->
      if (error != null) command.future.completeExceptionally(publicFailure(error))
      else command.future.complete(snapshot)
    }
  }

  private fun handleStop(command: RecorderServiceCommand.Stop) {
    val current = matchingEngine(command.sessionId, command.future) ?: return
    current.stop().whenComplete { result, error ->
      if (error != null) command.future.completeExceptionally(publicFailure(error))
      else command.future.complete(result)
      RecorderServiceClient.release(command.sessionId)
      LaojiMeetingTileService.requestRefresh(this)
      stoppingNormally = true
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private fun <T> matchingEngine(sessionId: String, future: CompletableFuture<T>): RecorderEngine? {
    val current = engine
    if (current == null || current.sessionId != sessionId) {
      future.completeExceptionally(
        RecorderRuntimeException(RecorderErrorCode.SESSION_MISMATCH, "recording service session does not match"),
      )
      return null
    }
    return current
  }

  private fun ensureForeground(state: RecorderState, mode: RecorderMode) {
    if (foregroundStarted) return
    val notification = buildNotification(state, mode)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    foregroundStarted = true
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      NOTIFICATION_CHANNEL_ID,
      "会议录音",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "正在使用麦克风录制会议"
      setSound(null, null)
      enableVibration(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun buildNotification(state: RecorderState, mode: RecorderMode): Notification {
    val text = when (state) {
      RecorderState.IDLE -> "等待开始录音"
      RecorderState.PREPARING -> "正在准备麦克风"
      RecorderState.RECORDING -> if (mode == RecorderMode.LOCAL_ONLY) "正在录音" else "正在录音并转写"
      RecorderState.PAUSED -> "录音已暂停"
      RecorderState.STOPPING -> "正在保存会议记录"
      RecorderState.LOCAL_SAVED -> "会议录音已保存在本机"
      RecorderState.FAILED -> "会议录音出现问题"
    }
    val icon = applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_btn_speak_now
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
      .setSmallIcon(icon)
      .setContentTitle("老记")
      .setContentText(text)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(contentIntent)
      .build()
  }

  private fun publicFailure(error: Throwable): RecorderRuntimeException {
    val unwrapped = error.cause ?: error
    return unwrapped as? RecorderRuntimeException
      ?: RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "native recording service failed")
  }
}
