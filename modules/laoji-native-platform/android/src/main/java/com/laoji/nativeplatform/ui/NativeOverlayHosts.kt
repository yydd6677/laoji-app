package com.laoji.nativeplatform.ui

// UI-OVERLAY-001, UI-MOTION-001: Overlay hosts own masking, lifecycle-safe presentation and motion.

import android.content.Context
import android.content.ContextWrapper
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.min

private fun asString(value: Any?): String = value as? String ?: ""

private fun asBoolean(value: Any?): Boolean = value as? Boolean ?: false

@Suppress("UNCHECKED_CAST")
private fun asMap(value: Any?): Map<String, Any?> = value as? Map<String, Any?> ?: emptyMap()

@Suppress("UNCHECKED_CAST")
private fun asList(value: Any?): List<Any?> = value as? List<Any?> ?: emptyList()

private class MaxHeightScrollView(context: Context, private val maxHeightPx: Int) : ScrollView(context) {
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val bounded = MeasureSpec.makeMeasureSpec(maxHeightPx, MeasureSpec.AT_MOST)
    super.onMeasure(widthMeasureSpec, bounded)
  }
}

abstract class NativeOverlayHostView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  protected val palette = NativeUiTokens.palette(context)
  protected val overlayRoot = FrameLayout(context)
  protected var navigationInsetPx = 0
  protected var showing = false
  protected var closing = false
  private var closeNotified = false
  private val backCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      dismissFromSystemBack()
    }
  }

  init {
    // UI-OVERLAY-001: Expo's padding-box clip can hide Android-managed overlay children.
    setWillNotDraw(false)
    clipToPadding = false
    orientation = VERTICAL
    addView(
      overlayRoot,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    setBackgroundColor(Color.TRANSPARENT)
    visibility = GONE
    isClickable = false
    ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
      val nextNavigationInset = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
      if (navigationInsetPx != nextNavigationInset) {
        navigationInsetPx = nextNavigationInset
        onNavigationInsetChanged()
        requestLayout()
      }
      insets
    }
    requestInsetsWhenAttached()
  }

  protected fun beginShow() {
    showing = true
    closing = false
    closeNotified = false
    visibility = VISIBLE
    isClickable = true
    backCallback.isEnabled = true
    alpha = 0f
    animate().alpha(1f).setDuration(NativeUiTokens.OVERLAY_DURATION_MS).start()
  }

  protected fun beginClose(onClosed: () -> Unit) {
    if (!showing || closing) return
    closing = true
    backCallback.isEnabled = false
    isClickable = false
    animate().alpha(0f).setDuration(NativeUiTokens.OVERLAY_DURATION_MS).withEndAction {
      if (closeNotified) return@withEndAction
      closeNotified = true
      showing = false
      closing = false
      visibility = GONE
      onClosed()
    }.start()
  }

  protected fun cancelOverlayAnimation() {
    animate().cancel()
  }

  protected fun disableSystemBack() {
    backCallback.isEnabled = false
  }

  protected abstract fun dismissFromSystemBack()

  protected open fun onNavigationInsetChanged() = Unit

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    context.componentActivity()?.onBackPressedDispatcher?.addCallback(backCallback)
    backCallback.isEnabled = showing
    requestInsetsWhenAttached()
  }

  override fun onDetachedFromWindow() {
    cancelOverlayAnimation()
    if (closing) {
      closing = false
      showing = true
      visibility = VISIBLE
      isClickable = true
      alpha = 1f
    }
    backCallback.remove()
    super.onDetachedFromWindow()
  }
}

class LaojiNativeDialogHostView(
  context: Context,
  appContext: AppContext,
) : NativeOverlayHostView(context, appContext) {
  private val onAction by EventDispatcher<Map<String, Any?>>()
  private val onDismiss by EventDispatcher<Map<String, Any?>>()
  private var bridgeEventsEnabled = true
  private var actionListener: ((Map<String, Any?>) -> Unit)? = null
  private var dismissListener: ((Map<String, Any?>) -> Unit)? = null
  private var snapshot: Map<String, Any?> = emptyMap()
  private var scrim: View? = null
  private var panel: LinearLayout? = null

  fun setSnapshot(value: Map<String, Any?>?) {
    val next = value ?: emptyMap()
    val nextVisible = asBoolean(next["visible"])
    snapshot = next
    if (nextVisible) {
      val wasClosing = closing
      if (wasClosing) cancelOverlayAnimation()
      render()
      if (!showing || wasClosing) beginShow()
    } else if (showing) {
      beginClose { emitDismiss(mapOf("reason" to "closed")) }
    }
  }

  fun setBridgeEventsEnabled(value: Boolean) {
    bridgeEventsEnabled = value
  }

  fun setActionListener(listener: ((Map<String, Any?>) -> Unit)?) {
    actionListener = listener
  }

  fun setDismissListener(listener: ((Map<String, Any?>) -> Unit)?) {
    dismissListener = listener
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    panel?.let { card ->
      val maxWidth = NativeUiTokens.dp(context, NativeUiTokens.DIALOG_MAX_WIDTH_DP).toInt()
      val horizontalMargin = NativeUiTokens.dp(context, 56f).toInt()
      card.layoutParams = (card.layoutParams ?: FrameLayout.LayoutParams(0, 0)).apply {
        width = min(maxWidth, (MeasureSpec.getSize(widthMeasureSpec) - horizontalMargin).coerceAtLeast(1))
      }
    }
  }

  private fun render() {
    overlayRoot.removeAllViews()
    val title = asString(snapshot["title"])
    val message = asString(snapshot["message"])
    val hint = asString(snapshot["hint"])
    val tone = asString(snapshot["tone"]).ifBlank { "info" }
    val actions = parseActions(snapshot["actions"])

    val mask = View(context).apply {
      setBackgroundColor(palette.mask)
      isClickable = true
      contentDescription = "关闭提示"
      setOnClickListener { requestDismiss() }
    }
    overlayRoot.addView(mask, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    scrim = mask

    val card = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      background = NativeUiTokens.roundedBackground(context, palette.surface, 6f)
      elevation = NativeUiTokens.dp(context, 8f)
      setOnClickListener { /* Consume taps inside the dialog. */ }
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
      contentDescription = listOf(title, message).filter { it.isNotBlank() }.joinToString("，")
    }
    val cardParams = FrameLayout.LayoutParams(
      NativeUiTokens.dp(context, NativeUiTokens.DIALOG_MAX_WIDTH_DP).toInt(),
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.CENTER,
    ).apply {
      leftMargin = NativeUiTokens.dp(context, 28f).toInt()
      rightMargin = NativeUiTokens.dp(context, 28f).toInt()
    }
    overlayRoot.addView(card, cardParams)
    panel = card

    val titleView = TextView(context).apply {
      text = title
      textSize = 17f
      setTextColor(palette.textPrimary)
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      gravity = Gravity.CENTER
      setPadding(
        NativeUiTokens.dp(context, 18f).toInt(),
        NativeUiTokens.dp(context, 20f).toInt(),
        NativeUiTokens.dp(context, 18f).toInt(),
        0,
      )
      minHeight = NativeUiTokens.dp(context, 44f).toInt()
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    card.addView(titleView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

    if (message.isNotBlank() || hint.isNotBlank()) {
      val content = MaxHeightScrollView(context, NativeUiTokens.dp(context, 168f).toInt()).apply {
        isFillViewport = true
        isVerticalScrollBarEnabled = false
        setPadding(
          NativeUiTokens.dp(context, 18f).toInt(),
          NativeUiTokens.dp(context, 10f).toInt(),
          NativeUiTokens.dp(context, 18f).toInt(),
          0,
        )
      }
      val contentColumn = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
      }
      if (message.isNotBlank()) {
        contentColumn.addView(dialogText(message, 14f, palette.textSecondary))
      }
      if (hint.isNotBlank()) {
        val hintView = dialogText(hint, 12f, palette.textTertiary)
        hintView.setPadding(0, NativeUiTokens.dp(context, if (message.isNotBlank()) 8f else 0f).toInt(), 0, 0)
        contentColumn.addView(hintView)
      }
      content.addView(contentColumn, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      card.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    val actionBar = LinearLayout(context).apply {
      orientation = if (actions.size <= 2) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(0, NativeUiTokens.dp(context, 20f).toInt(), 0, 0)
    }
    card.addView(actionBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addDialogActions(actionBar, actions, tone)
  }

  private fun dialogText(value: String, sizeSp: Float, color: Int): TextView = TextView(context).apply {
    text = value
    textSize = sizeSp
    setTextColor(color)
    gravity = Gravity.CENTER
    setLineSpacing(0f, 1.25f)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  private fun addDialogActions(container: LinearLayout, actions: List<NativeDialogAction>, tone: String) {
    if (actions.isEmpty()) {
      addAction(container, NativeDialogAction("知道了", "primary", 0), tone, true)
      return
    }
    val displayed = if (actions.size <= 2) actions.asReversed() else actions
    displayed.forEachIndexed { index, action ->
      if (index > 0) {
        val divider = View(context).apply { setBackgroundColor(palette.divider) }
        val dividerParams = if (actions.size <= 2) {
          LinearLayout.LayoutParams(NativeUiTokens.dp(context, NativeUiTokens.DIVIDER_DP).toInt().coerceAtLeast(1), NativeUiTokens.dp(context, NativeUiTokens.DIALOG_ACTION_HEIGHT_DP).toInt())
        } else {
          LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, NativeUiTokens.dp(context, NativeUiTokens.DIVIDER_DP).toInt().coerceAtLeast(1))
        }
        container.addView(divider, dividerParams)
      }
      addAction(container, action, tone, actions.size <= 2)
    }
  }

  private fun addAction(container: LinearLayout, action: NativeDialogAction, tone: String, inline: Boolean) {
    val color = when (action.role) {
      "destructive" -> palette.danger
      "primary" -> palette.primary
      else -> palette.textPrimary
    }
    val actionView = TextView(context).apply {
      text = action.text
      textSize = 17f
      setTextColor(color)
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
      gravity = Gravity.CENTER
      minHeight = NativeUiTokens.dp(context, NativeUiTokens.DIALOG_ACTION_HEIGHT_DP).toInt()
      isClickable = true
      isFocusable = true
      accessibilityRoleCompat("button")
      contentDescription = action.text
      setOnClickListener {
        performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        emitAction(mapOf("index" to action.index, "role" to action.role, "tone" to tone))
      }
    }
    val params = if (inline) {
      LinearLayout.LayoutParams(0, NativeUiTokens.dp(context, NativeUiTokens.DIALOG_ACTION_HEIGHT_DP).toInt(), 1f)
    } else {
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, NativeUiTokens.dp(context, NativeUiTokens.DIALOG_ACTION_HEIGHT_DP).toInt())
    }
    container.addView(actionView, params)
  }

  private fun requestDismiss() {
    if (closing) return
    beginClose { emitDismiss(mapOf("reason" to "backdrop")) }
  }

  override fun dismissFromSystemBack() {
    requestDismiss()
  }

  private fun parseActions(value: Any?): List<NativeDialogAction> = asList(value).mapIndexedNotNull { index, raw ->
    val item = asMap(raw)
    val text = asString(item["text"])
    if (text.isBlank()) null else NativeDialogAction(text, asString(item["role"]).ifBlank { if (index == 0) "primary" else "secondary" }, index)
  }

  private fun emitAction(payload: Map<String, Any?>) {
    actionListener?.invoke(payload)
    if (bridgeEventsEnabled) onAction(payload)
  }

  private fun emitDismiss(payload: Map<String, Any?>) {
    dismissListener?.invoke(payload)
    if (bridgeEventsEnabled) onDismiss(payload)
  }

  private data class NativeDialogAction(val text: String, val role: String, val index: Int)
}

class LaojiNativeActionSheetHostView(
  context: Context,
  appContext: AppContext,
) : NativeOverlayHostView(context, appContext) {
  private val onItem by EventDispatcher<Map<String, Any?>>()
  private val onDismiss by EventDispatcher<Map<String, Any?>>()
  private var bridgeEventsEnabled = true
  private var itemListener: ((Map<String, Any?>) -> Unit)? = null
  private var dismissListener: ((Map<String, Any?>) -> Unit)? = null
  private var snapshot: Map<String, Any?> = emptyMap()
  private var frame: LinearLayout? = null

  fun setSnapshot(value: Map<String, Any?>?) {
    val next = value ?: emptyMap()
    val nextVisible = asBoolean(next["visible"])
    snapshot = next
    if (nextVisible) {
      val wasClosing = closing
      if (wasClosing) frame?.animate()?.cancel()
      render()
      if (!showing || wasClosing) {
        beginShow()
        frame?.post {
          frame?.translationY = height.toFloat()
          frame?.animate()?.translationY(0f)?.setDuration(NativeUiTokens.SHEET_DURATION_MS)?.start()
        }
      }
    } else if (showing) {
      closeSheet("closed")
    }
  }

  fun setBridgeEventsEnabled(value: Boolean) {
    bridgeEventsEnabled = value
  }

  fun setItemListener(listener: ((Map<String, Any?>) -> Unit)?) {
    itemListener = listener
  }

  fun setDismissListener(listener: ((Map<String, Any?>) -> Unit)?) {
    dismissListener = listener
  }

  override fun onNavigationInsetChanged() {
    frame?.setPadding(
      NativeUiTokens.dp(context, NativeUiTokens.SHEET_EDGE_MARGIN_DP).toInt(),
      0,
      NativeUiTokens.dp(context, NativeUiTokens.SHEET_EDGE_MARGIN_DP).toInt(),
      navigationInsetPx + NativeUiTokens.dp(context, NativeUiTokens.SHEET_EDGE_MARGIN_DP).toInt(),
    )
  }

  private fun render() {
    overlayRoot.removeAllViews()
    val title = asString(snapshot["title"])
    val items = asList(snapshot["items"]).mapIndexedNotNull { index, raw ->
      val item = asMap(raw)
      val key = asString(item["key"])
      val label = asString(item["label"])
      if (key.isBlank() || label.isBlank()) null else NativeSheetItem(
        key,
        label,
        asBoolean(item["destructive"]),
        asBoolean(item["disabled"]),
        index,
      )
    }

    val mask = View(context).apply {
      setBackgroundColor(palette.mask)
      isClickable = true
      contentDescription = "关闭菜单"
      setOnClickListener { closeSheet("backdrop") }
    }
    overlayRoot.addView(mask, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    val outer = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(
        NativeUiTokens.dp(context, NativeUiTokens.SHEET_EDGE_MARGIN_DP).toInt(),
        0,
        NativeUiTokens.dp(context, NativeUiTokens.SHEET_EDGE_MARGIN_DP).toInt(),
        navigationInsetPx + NativeUiTokens.dp(context, NativeUiTokens.SHEET_EDGE_MARGIN_DP).toInt(),
      )
    }
    frame = outer
    val frameParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM)
    overlayRoot.addView(outer, frameParams)

    val panel = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      background = NativeUiTokens.roundedBackground(context, palette.body, 8f)
      clipChildren = true
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
      contentDescription = title.ifBlank { "操作菜单" }
      setOnClickListener { /* Consume taps inside the sheet. */ }
    }
    outer.addView(panel, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    if (title.isNotBlank()) {
      panel.addView(TextView(context).apply {
        text = title
        textSize = 14f
        setTextColor(palette.textTertiary)
        gravity = Gravity.CENTER
        minHeight = NativeUiTokens.dp(context, 52f).toInt()
        setPadding(NativeUiTokens.dp(context, 12f).toInt(), 0, NativeUiTokens.dp(context, 12f).toInt(), 0)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
      }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, NativeUiTokens.dp(context, 52f).toInt()))
      addDivider(panel)
    }
    items.forEachIndexed { index, item ->
      val itemView = TextView(context).apply {
        text = item.label
        textSize = 17f
        setTextColor(if (item.disabled) palette.textDisabled else if (item.destructive) palette.danger else palette.textPrimary)
        gravity = Gravity.CENTER
        minHeight = NativeUiTokens.dp(context, NativeUiTokens.SHEET_ITEM_HEIGHT_DP).toInt()
        isEnabled = !item.disabled
        isClickable = !item.disabled
        isFocusable = !item.disabled
        contentDescription = item.label
        accessibilityRoleCompat("menuitem")
        if (!item.disabled) {
          setOnClickListener {
            performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
            emitItem(mapOf("key" to item.key, "index" to item.index))
            closeSheet("item")
          }
        }
      }
      panel.addView(itemView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, NativeUiTokens.dp(context, NativeUiTokens.SHEET_ITEM_HEIGHT_DP).toInt()))
      if (index < items.lastIndex) addDivider(panel)
    }

    val cancel = TextView(context).apply {
      text = "取消"
      textSize = 17f
      setTextColor(palette.textPrimary)
      gravity = Gravity.CENTER
      // The cancel action is a separate Feishu-style rounded surface. Without
      // an explicit drawable TextView defaults to transparent and the overlay
      // mask shows through, which makes the button look missing.
      background = NativeUiTokens.roundedBackground(context, palette.body, 8f)
      minHeight = NativeUiTokens.dp(context, NativeUiTokens.SHEET_CANCEL_HEIGHT_DP).toInt()
      isClickable = true
      isFocusable = true
      contentDescription = "取消"
      accessibilityRoleCompat("button")
      setOnClickListener { closeSheet("cancel") }
    }
    val cancelParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, NativeUiTokens.dp(context, NativeUiTokens.SHEET_CANCEL_HEIGHT_DP).toInt())
    cancelParams.topMargin = NativeUiTokens.dp(context, NativeUiTokens.SHEET_CANCEL_GAP_DP).toInt()
    outer.addView(cancel, cancelParams)
  }

  private fun addDivider(parent: LinearLayout) {
    parent.addView(View(context).apply { setBackgroundColor(palette.divider) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, NativeUiTokens.dp(context, NativeUiTokens.DIVIDER_DP).toInt().coerceAtLeast(1)))
  }

  private fun closeSheet(reason: String) {
    if (closing || !showing) return
    closing = true
    disableSystemBack()
    isClickable = false
    frame?.animate()?.translationY(height.toFloat())?.setDuration(NativeUiTokens.SHEET_DURATION_MS)?.withEndAction {
      showing = false
      closing = false
      visibility = GONE
      emitDismiss(mapOf("reason" to reason))
    }?.start()
  }

  override fun dismissFromSystemBack() {
    closeSheet("system-back")
  }

  private fun emitItem(payload: Map<String, Any?>) {
    itemListener?.invoke(payload)
    if (bridgeEventsEnabled) onItem(payload)
  }

  private fun emitDismiss(payload: Map<String, Any?>) {
    dismissListener?.invoke(payload)
    if (bridgeEventsEnabled) onDismiss(payload)
  }

  private data class NativeSheetItem(
    val key: String,
    val label: String,
    val destructive: Boolean,
    val disabled: Boolean,
    val index: Int,
  )
}

private fun Context.componentActivity(): ComponentActivity? {
  var cursor: Context? = this
  while (cursor is ContextWrapper) {
    if (cursor is ComponentActivity) return cursor
    cursor = cursor.baseContext
  }
  return cursor as? ComponentActivity
}

private fun TextView.accessibilityRoleCompat(role: String) {
  contentDescription = contentDescription ?: text
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
    stateDescription = role
  }
}
