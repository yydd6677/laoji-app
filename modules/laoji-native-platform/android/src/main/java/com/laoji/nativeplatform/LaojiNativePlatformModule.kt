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
import com.laoji.nativeplatform.ui.LaojiSystemBars
import com.laoji.nativeplatform.ui.NativeUiTokens
import com.laoji.nativeplatform.ui.LaojiThemeTypography
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.UUID

class LaojiNativePlatformModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiNativePlatform")

    // THEME-001: keep the selected skin available synchronously to module-level
    // React Native styles and to the Android calendar/minutes surfaces.
    Function("getThemePreference") {
      NativeThemePreference.read(appContext.reactContext?.applicationContext)
    }

    Function("setThemePreference") { themeId: String ->
      NativeThemePreference.write(appContext.reactContext?.applicationContext, themeId)
      appContext.currentActivity?.let { activity ->
        activity.runOnUiThread {
          LaojiThemeTypography.applyActivityTheme(activity)
          LaojiSystemBars.apply(activity)
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

  }

}

internal object NativeThemePreference {
  private const val PREFS_NAME = "laoji_preferences"
  private const val KEY_THEME = "theme_id"
  private const val DEFAULT_THEME = "neutral"

  fun read(context: Context?): String {
    val prefs = context?.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val value = prefs?.getString(KEY_THEME, DEFAULT_THEME)
    return value?.takeIf { it in supportedThemes } ?: DEFAULT_THEME
  }

  fun write(context: Context?, themeId: String) {
    val normalized = themeId.takeIf { it in supportedThemes } ?: DEFAULT_THEME
    val previous = read(context)
    context?.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      ?.edit()
      ?.putString(KEY_THEME, normalized)
      ?.commit()
    if (previous != read(context)) NativeUiTokens.onThemePreferenceChanged()
  }

  fun isVivid(context: Context?): Boolean = read(context) == "vivid"
  fun isPaper(context: Context?): Boolean = read(context) == "paper"
  fun isMidnight(context: Context?): Boolean = read(context) == "midnight"

  private val supportedThemes = setOf("neutral", "vivid", "paper", "midnight")
}
