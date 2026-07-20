package com.laoji.nativeplatform

// CAL-LOCATION-001: Android LocationManager fallback for devices whose Google
// fused client reports inactive even while the system providers hold a fresh fix.

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean

class LaojiLocationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiLocation")

    AsyncFunction("getCurrentLocation") {
      maxAgeMs: Double,
      requiredAccuracyMeters: Double,
      timeoutMs: Double,
      promise: Promise ->
      val context = requireContext()
      val hasPermission = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
      if (!hasPermission) {
        promise.reject("ERR_LAOJI_LOCATION_PERMISSION", "location permission is unavailable", null)
        return@AsyncFunction
      }

      Handler(Looper.getMainLooper()).post {
        requestLocation(
          context = context,
          maxAgeMs = maxAgeMs.coerceIn(0.0, 60.0 * 60_000.0).toLong(),
          requiredAccuracyMeters = requiredAccuracyMeters.coerceIn(1.0, 10_000.0).toFloat(),
          timeoutMs = timeoutMs.coerceIn(1_000.0, 30_000.0).toLong(),
          promise = promise,
        )
      }
    }
  }

  private fun requestLocation(
    context: Context,
    maxAgeMs: Long,
    requiredAccuracyMeters: Float,
    timeoutMs: Long,
    promise: Promise,
  ) {
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    if (manager == null) {
      promise.resolve(null)
      return
    }

    val enabledProviders = try {
      manager.getProviders(true)
    } catch (_: RuntimeException) {
      emptyList()
    }
    val lastKnown = enabledProviders.mapNotNull { provider ->
      try {
        manager.getLastKnownLocation(provider)
      } catch (_: SecurityException) {
        null
      } catch (_: RuntimeException) {
        null
      }
    }.filter(::isUsableLocation)

    val fresh = lastKnown
      .filter { locationAgeMs(it) <= maxAgeMs && accuracyMeters(it) <= requiredAccuracyMeters }
      .minWithOrNull(compareBy<Location>({ locationAgeMs(it) }, { accuracyMeters(it) }))
    if (fresh != null) {
      promise.resolve(locationMap(fresh))
      return
    }

    val requestProviders = listOf(
      LocationManager.NETWORK_PROVIDER,
      "fused",
      LocationManager.GPS_PROVIDER,
    ).filter { provider -> enabledProviders.contains(provider) }.distinct()
    if (requestProviders.isEmpty()) {
      promise.resolve(null)
      return
    }

    val settled = AtomicBoolean(false)
    val handler = Handler(Looper.getMainLooper())
    lateinit var listener: LocationListener
    val finish: (Location?) -> Unit = { location ->
      if (settled.compareAndSet(false, true)) {
        handler.removeCallbacksAndMessages(listener)
        try {
          manager.removeUpdates(listener)
        } catch (_: SecurityException) {
          // Permission state can change while the picker is open.
        } catch (_: RuntimeException) {
          // Provider shutdown should not turn a recoverable miss into a crash.
        }
        promise.resolve(location?.let(::locationMap))
      }
    }
    listener = LocationListener { location ->
      if (isUsableLocation(location) && accuracyMeters(location) <= requiredAccuracyMeters) {
        finish(location)
      }
    }

    val timeout = Runnable { finish(null) }
    handler.postAtTime(timeout, listener, SystemClock.uptimeMillis() + timeoutMs)
    var registered = false
    requestProviders.forEach { provider ->
      try {
        manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
        registered = true
      } catch (_: SecurityException) {
        // The TypeScript permission path will provide the localized explanation.
      } catch (_: IllegalArgumentException) {
        // An OEM can advertise a provider that disappears before registration.
      } catch (_: RuntimeException) {
        // Continue with the remaining system providers.
      }
    }
    if (!registered) finish(null)
  }

  private fun requireContext(): Context = appContext.reactContext?.applicationContext
    ?: throw IllegalStateException("Android application context is unavailable")

  private fun isUsableLocation(location: Location): Boolean =
    location.latitude.isFinite() &&
      location.longitude.isFinite() &&
      location.latitude in -90.0..90.0 &&
      location.longitude in -180.0..180.0

  private fun accuracyMeters(location: Location): Float =
    if (location.hasAccuracy() && location.accuracy.isFinite() && location.accuracy >= 0f) {
      location.accuracy
    } else {
      Float.POSITIVE_INFINITY
    }

  private fun locationAgeMs(location: Location): Long {
    val elapsedNanos = location.elapsedRealtimeNanos
    if (elapsedNanos > 0L) {
      return ((SystemClock.elapsedRealtimeNanos() - elapsedNanos) / 1_000_000L).coerceAtLeast(0L)
    }
    return (System.currentTimeMillis() - location.time).coerceAtLeast(0L)
  }

  private fun locationMap(location: Location): Map<String, Any?> = mapOf(
    "latitude" to location.latitude,
    "longitude" to location.longitude,
    "accuracy" to accuracyMeters(location).toDouble(),
    "ageMs" to locationAgeMs(location).toDouble(),
    "provider" to location.provider,
  )
}
