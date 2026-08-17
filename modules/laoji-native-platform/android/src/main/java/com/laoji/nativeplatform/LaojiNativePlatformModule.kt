package com.laoji.nativeplatform

// CAL-ROOT-001 / MIN-ROOT-001 / MIN-AUDIO-001 / MIN-PLAYER-001: runtime capability truth.

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import android.util.Log
import android.view.View
import android.view.ViewGroup
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.UUID

private const val THEME_TAG = "LaojiTheme"

class LaojiNativePlatformModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiNativePlatform")

    Constant("evidenceSchemaVersion") { 1 }
    Constant("implementation") { "android-classic-view" }

    // THEME-001: keep the selected skin available synchronously to module-level
    // React Native styles and to the Android calendar/minutes surfaces.
    Function("getThemePreference") {
      NativeThemePreference.read(appContext.reactContext?.applicationContext)
    }

    Function("setThemePreference") { themeId: String ->
      NativeThemePreference.write(appContext.reactContext?.applicationContext, themeId)
    }

    Function("restartActivity") {
      val activity = appContext.currentActivity
      if (activity != null) {
        activity.runOnUiThread {
          // React Native 0.81's bridgeless reload owns the complete JS/module
          // lifecycle, which is required for module-level theme tokens. Its
          // surface restart has a race where it may reset the root View id from
          // a background executor; clear that id on the main thread first.
          if (reloadReactRuntime(activity)) return@runOnUiThread

          // Keep a lifecycle-safe fallback for builds where the ReactHost
          // boundary is unavailable after shrinking. This preserves the
          // process and lets Expo recreate the surface normally.
          activity.recreate()
        }
      }
    }

    Function("createRandomUuid") { UUID.randomUUID().toString() }

    AsyncFunction("sha256File") { fileUri: String ->
      val uri = Uri.parse(fileUri)
      require(uri.scheme == "file") { "file URI is required" }
      val source = File(requireNotNull(uri.path) { "file path is required" }).canonicalFile
      require(source.isFile) { "file is unavailable" }
      val digest = MessageDigest.getInstance("SHA-256")
      var byteSize = 0L
      FileInputStream(source).use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (count == 0) continue
          digest.update(buffer, 0, count)
          byteSize = Math.addExact(byteSize, count.toLong())
        }
      }
      mapOf(
        "checksumSha256" to "sha256:${digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }}",
        "byteSize" to byteSize,
      )
    }

    // Android keeps the final installation confirmation in the system
    // installer. LaoJi only exposes the verified cache file through a
    // FileProvider; it never performs a silent install.
    Function("canInstallApk") {
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("应用环境不可用")
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O
        || context.packageManager.canRequestPackageInstalls()
    }

    Function("openApkInstallSettings") {
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("应用环境不可用")
      val activity = appContext.currentActivity
        ?: throw IllegalStateException("当前页面不可用")
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
          data = Uri.parse("package:${context.packageName}")
        }
      } else {
        Intent(Settings.ACTION_SECURITY_SETTINGS)
      }
      activity.startActivity(intent)
      true
    }

    Function("installApk") { fileUri: String, expectedVersionCode: Long ->
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("应用环境不可用")
      val activity = appContext.currentActivity
        ?: throw IllegalStateException("当前页面不可用")
      require(Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()) {
        "请先允许老记安装应用更新。"
      }
      val sourceUri = Uri.parse(fileUri)
      require(sourceUri.scheme == "file") { "安装文件路径无效" }
      val source = File(requireNotNull(sourceUri.path) { "安装文件路径无效" }).canonicalFile
      require(source.isFile) { "安装文件不存在" }
      val archive = context.packageManager.getPackageArchiveInfo(source.path, 0)
        ?: throw IllegalArgumentException("安装文件无法识别")
      val archiveVersionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        archive.longVersionCode
      } else {
        @Suppress("DEPRECATION")
        archive.versionCode.toLong()
      }
      require(archive.packageName == context.packageName && archiveVersionCode == expectedVersionCode) {
        "安装文件版本不匹配，已取消安装。"
      }
      val contentUri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.laoji.fileprovider",
        source,
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(intent)
      true
    }

    AsyncFunction("getCapabilities") {
      mapOf(
        "calendarSurface" to true,
        "minutesSurface" to true,
        "nativeAudioRuntime" to true,
        "mediaPlayer" to true
      )
    }
  }

  private fun reloadReactRuntime(activity: android.app.Activity): Boolean {
    return try {
      val application = activity.application
      val reactHost = application.javaClass.methods
        .firstOrNull { it.name == "getReactHost" }
        ?.invoke(application)
      val reloadHostMethod = reactHost?.javaClass?.methods
        ?.firstOrNull { it.name == "reload" && it.parameterTypes.size == 1 }
      if (reactHost == null || reloadHostMethod == null) {
        Log.w(THEME_TAG, "ReactHost reload unavailable")
        return false
      }

      resetReactSurfaceRootIds(activity.window.decorView)
      reloadHostMethod.isAccessible = true
      Log.i(THEME_TAG, "using ReactHost reload: ${reactHost.javaClass.name}")
      reloadHostMethod.invoke(reactHost, "主题偏好已更新")
      true
    } catch (error: Throwable) {
      Log.e(THEME_TAG, "React runtime reload failed", error)
      false
    }
  }

  private fun resetReactSurfaceRootIds(view: View) {
    if (view.javaClass.name.contains("ReactSurfaceView") && view.id != View.NO_ID) {
      view.id = View.NO_ID
    }
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        resetReactSurfaceRootIds(view.getChildAt(index))
      }
    }
  }

}

internal object NativeThemePreference {
  private const val PREFS_NAME = "laoji_preferences"
  private const val KEY_THEME = "theme_id"
  private const val DEFAULT_THEME = "neutral"

  fun read(context: Context?): String {
    val prefs = context?.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val value = prefs?.getString(KEY_THEME, DEFAULT_THEME)
    return if (value == "vivid") "vivid" else DEFAULT_THEME
  }

  fun write(context: Context?, themeId: String) {
    val normalized = if (themeId == "vivid") "vivid" else DEFAULT_THEME
    context?.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      ?.edit()
      ?.putString(KEY_THEME, normalized)
      ?.commit()
  }

  fun isVivid(context: Context?): Boolean = read(context) == "vivid"
}
