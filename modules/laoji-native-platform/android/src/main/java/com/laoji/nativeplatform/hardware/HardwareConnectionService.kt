package com.laoji.nativeplatform.hardware

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat

/** Keeps an explicitly connected board alive without using the phone microphone. */
class HardwareConnectionService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var token = -1L
  private var started = false
  private var wakeLock: PowerManager.WakeLock? = null
  private var lastWakeRenewedMs = 0L
  private var visibleText: String? = null
  private val listener = object : HardwareRuntimeListener {
    override fun onState(snapshot: HardwareRuntimeSnapshot) { handler.post { render(snapshot) } }
  }
  private val tick = object : Runnable {
    override fun run() { render(HardwareRuntime.getState()); handler.postDelayed(this, 60_000) }
  }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java)
      .createNotificationChannel(NotificationChannel(CHANNEL, "外接录音设备", NotificationManager.IMPORTANCE_LOW))
    HardwareRuntimeEvents.add(listener)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    token = intent?.getLongExtra("connection_epoch", -1) ?: -1
    if (!HardwareRuntime.serviceConnectionActive(token)) { stopSelf(startId); return START_NOT_STICKY }
    try {
      val text = HardwareConnectionNoticePolicy.text(HardwareRuntime.getState().phase)
      val notification = notification(text)
      if (Build.VERSION.SDK_INT >= 29) startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      else startForeground(ID, notification)
      started = true
      visibleText = text
      handler.removeCallbacks(tick); handler.post(tick)
    } catch (_: RuntimeException) {
      HardwareRuntime.serviceUnavailable(token)
      stopSelf(startId)
    }
    return START_NOT_STICKY
  }

  private fun render(snapshot: HardwareRuntimeSnapshot) {
    if (!started || !HardwareRuntime.serviceConnectionActive(token)) return
    val active = HardwareConnectionNoticePolicy.needsWake(snapshot.phase)
    if (active) {
      val wake = wakeLock ?: getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "laoji:external-audio").apply { setReferenceCounted(false); wakeLock = this }
      val now = SystemClock.elapsedRealtime()
      if (HardwareConnectionNoticePolicy.renewWake(wake.isHeld, now, lastWakeRenewedMs)) {
        wake.acquire(10 * 60 * 1000L)
        lastWakeRenewedMs = now
      }
    } else if (wakeLock?.isHeld == true) wakeLock?.release()
    val text = HardwareConnectionNoticePolicy.text(snapshot.phase, snapshot.purpose)
    if (text != visibleText) {
      getSystemService(NotificationManager::class.java).notify(ID, notification(text))
      visibleText = text
    }
  }
  private fun notification(text: String): android.app.Notification {
    val builder = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(com.laoji.nativeplatform.R.drawable.laoji_ic_quick_tile_record)
      .setContentTitle("外接录音设备").setContentText(text)
      .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      builder.setContentIntent(PendingIntent.getActivity(this, 731, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    }
    return builder.build()
  }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onDestroy() {
    HardwareRuntimeEvents.remove(listener)
    handler.removeCallbacksAndMessages(null)
    if (wakeLock?.isHeld == true) wakeLock?.release()
    HardwareRuntime.serviceUnavailable(token)
    super.onDestroy()
  }
  companion object {
    private const val CHANNEL = "laoji_external_recorder"
    private const val ID = 731
    fun start(context: Context, token: Long) {
      val intent = Intent(context, HardwareConnectionService::class.java).putExtra("connection_epoch", token)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
    }
    fun stop(context: Context) { context.stopService(Intent(context, HardwareConnectionService::class.java)) }
  }
}
