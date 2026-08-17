package com.laoji.nativeplatform.ui

// [PRODUCT] Calendar and Minutes expose one global settings entry in the same
// leading-title-bar position. The surrounding title bars keep domain ownership.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import expo.modules.interfaces.imageloader.ImageLoaderInterface
import expo.modules.kotlin.AppContext

class ProfileEntryView(
  context: Context,
  private val appContext: AppContext,
) : FrameLayout(context) {
  private val palette = NativeUiTokens.palette(context)
  private val avatarFrame = FrameLayout(context)
  private val placeholder = ImageView(context)
  private val image = ImageView(context)
  private var avatarUri: String? = null
  private var loadedUri: String? = null
  private var loadingUri: String? = null
  private var loadGeneration = 0

  init {
    isFocusable = true
    updateAccessibilityLabel("打开设置")
    background = RippleDrawable(
      ColorStateList.valueOf(palette.primarySoft),
      null,
      GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(palette.surface)
      },
    )

    avatarFrame.apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(palette.surfaceOverlay)
      }
      outlineProvider = ViewOutlineProvider.BACKGROUND
      clipToOutline = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    addView(
      avatarFrame,
      LayoutParams(dp(NativeUiTokens.PROFILE_ENTRY_AVATAR_SIZE_DP), dp(NativeUiTokens.PROFILE_ENTRY_AVATAR_SIZE_DP), Gravity.CENTER),
    )

    placeholder.apply {
      setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_settings_outline)
      imageTintList = ColorStateList.valueOf(palette.textTertiary)
      scaleType = ImageView.ScaleType.CENTER_INSIDE
      setPadding(dp(7f), dp(7f), dp(7f), dp(7f))
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    avatarFrame.addView(
      placeholder,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )

    image.apply {
      scaleType = ImageView.ScaleType.CENTER_CROP
      visibility = View.GONE
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    avatarFrame.addView(
      image,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )
  }

  fun setSnapshot(snapshot: Map<String, Any?>) {
    updateAccessibilityLabel((snapshot["accessibilityLabel"] as? String)
      ?.trim()
      ?.takeIf(String::isNotEmpty)
      ?: "打开设置")
    val nextUri = (snapshot["avatarUri"] as? String)
      ?.trim()
      ?.takeIf(String::isNotEmpty)
    if (nextUri == avatarUri && (loadedUri == nextUri || loadingUri == nextUri)) return
    avatarUri = nextUri
    loadedUri = null
    loadingUri = null
    showPlaceholder()
    if (nextUri == null) return
    loadAvatar(nextUri)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val currentUri = avatarUri ?: return
    if (loadedUri != currentUri && loadingUri != currentUri) post { loadAvatar(currentUri) }
  }

  override fun onDetachedFromWindow() {
    loadGeneration += 1
    loadingUri = null
    super.onDetachedFromWindow()
  }

  override fun getAccessibilityClassName(): CharSequence = Button::class.java.name

  private fun loadAvatar(uri: String) {
    if (!isAttachedToWindow || avatarUri != uri || loadingUri == uri || loadedUri == uri) return
    val loader = appContext.imageLoader ?: return
    loadGeneration += 1
    val generation = loadGeneration
    loadingUri = uri
    loader.loadImageForDisplayFromURL(
      uri,
      object : ImageLoaderInterface.ResultListener {
        override fun onSuccess(bitmap: Bitmap) {
          post {
            if (generation != loadGeneration || avatarUri != uri) return@post
            loadingUri = null
            loadedUri = uri
            image.setImageBitmap(bitmap)
            image.visibility = View.VISIBLE
            placeholder.visibility = View.GONE
          }
        }

        override fun onFailure(cause: Throwable?) {
          post {
            if (generation == loadGeneration && avatarUri == uri) {
              loadingUri = null
              loadedUri = null
              showPlaceholder()
            }
          }
        }
      },
    )
  }

  private fun updateAccessibilityLabel(label: String) {
    contentDescription = label
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) tooltipText = label
  }

  private fun showPlaceholder() {
    image.setImageDrawable(null)
    image.visibility = View.GONE
    placeholder.visibility = View.VISIBLE
  }

  private fun dp(value: Float): Int = NativeUiTokens.dp(context, value).toInt()
}
