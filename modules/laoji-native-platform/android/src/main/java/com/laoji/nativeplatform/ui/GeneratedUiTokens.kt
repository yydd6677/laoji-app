// Generated from design-system/tokens/core.tokens.json; SHA-256 c2cc95f252e4a6894c6a54b82e8f51781d63aed576b7eda4cb0bdaa2cd98d1d4. DO NOT EDIT.
package com.laoji.nativeplatform.ui

internal object GeneratedUiTokens {
  const val fontFamily_neutral = "LaojiThemeNeutral"
  const val fontFamily_vivid = "LaojiThemeVivid"
  const val fontFamily_paper = "LaojiThemePaper"
  const val fontFamily_midnight = "LaojiThemeMidnight"
  const val fontSize_title0 = 26.0f
  const val fontSize_title1 = 24.0f
  const val fontSize_title2 = 20.0f
  const val fontSize_title3 = 17.0f
  const val fontSize_body0 = 16.0f
  const val fontSize_body1 = 14.0f
  const val fontSize_caption1 = 12.0f
  const val fontSize_caption2 = 10.0f
  const val fontSize_caption3 = 10.0f
  const val radius_xs = 2.0f
  const val radius_s = 4.0f
  const val radius_m = 6.0f
  const val radius_l = 8.0f
  const val radius_xl = 10.0f
  const val radius_xxl = 12.0f
  const val dimension_divider = 0.5f
  const val dimension_titleBarHeight = 44.0f
  const val dimension_titleBarIconTarget = 44.0f
  const val dimension_iconTarget = 48.0f
  const val dimension_profileEntryHitSize = 44.0f
  const val dimension_profileEntryAvatarSize = 36.0f
  const val dimension_compactIconTarget = 40.0f
  const val dimension_viewBarHeight = 50.0f
  const val dimension_fabSize = 48.0f
  const val dimension_fabInset = 16.0f
  const val dimension_startupStateVisualSize = 125.0f
  const val dimension_emptyIllustrationSize = 100.0f
  const val dimension_retryButtonWidth = 76.0f
  const val dimension_retryButtonHeight = 36.0f
  const val dimension_saveActionWidth = 64.0f
  const val dimension_toastMaxWidth = 295.0f
  const val dimension_toastMinHeight = 40.0f
  const val dimension_toastIconSize = 20.0f
  const val dimension_toastActionMaxWidth = 75.0f
  const val dimension_dialogMaxWidth = 296.0f
  const val dimension_dialogContentWidth = 260.0f
  const val dimension_dialogActionHeight = 50.0f
  const val dimension_sheetMaxWidth = 450.0f
  const val dimension_sheetEdgeMargin = 12.0f
  const val dimension_sheetHeaderHeight = 52.0f
  const val dimension_sheetItemHeight = 52.0f
  const val dimension_sheetCancelHeight = 48.0f
  const val dimension_sheetCancelGap = 12.0f
  const val motion_fabSegment = 170L
  const val motion_calendarDragHaptic = 80L
  const val motion_minutesLongPressHaptic = 100L
  const val motion_chapterHaptic = 20L
  const val motion_playbackSpeedHaptic = 50L
  const val motion_insufficientSpaceHaptic = 500L
  const val motion_overlayDuration = 170L
  const val motion_sheetDuration = 300L
  const val motion_toastDuration = 200L

  data class ThemePalette(
    val appBg: Int,
    val body: Int,
    val card: Int,
    val inputBg: Int,
    val tasksBg: Int,
    val waveformBg: Int,
    val loginTop: Int,
    val loginBot: Int,
    val logoFrom: Int,
    val logoTo: Int,
    val primary: Int,
    val primaryHover: Int,
    val primaryPressed: Int,
    val primaryLight: Int,
    val purple: Int,
    val purpleDark: Int,
    val gradFrom: Int,
    val gradTo: Int,
    val purpleLight: Int,
    val text: Int,
    val sub: Int,
    val faint: Int,
    val disabled: Int,
    val pressed: Int,
    val green: Int,
    val orange: Int,
    val blue: Int,
    val pink: Int,
    val pinkBorder: Int,
    val red: Int,
    val teal: Int,
    val border: Int,
    val divider: Int,
    val calendarGridDivider: Int,
    val overlay: Int,
  )

  private val neutralPalette = ThemePalette(
    appBg = 0xfff3f6fa.toInt(),
    body = 0xfffcfdff.toInt(),
    card = 0xffffffff.toInt(),
    inputBg = 0xffeef3fa.toInt(),
    tasksBg = 0xffeff4ff.toInt(),
    waveformBg = 0xffedf3fb.toInt(),
    loginTop = 0xffffffff.toInt(),
    loginBot = 0xfff2f3f5.toInt(),
    logoFrom = 0xff5b91f2.toInt(),
    logoTo = 0xff2768e8.toInt(),
    primary = 0xff2768e8.toInt(),
    primaryHover = 0xff3c78ee.toInt(),
    primaryPressed = 0xff1b55c8.toInt(),
    primaryLight = 0xffeaf1ff.toInt(),
    purple = 0xff2768e8.toInt(),
    purpleDark = 0xff1b55c8.toInt(),
    gradFrom = 0xff4d7fea.toInt(),
    gradTo = 0xff2768e8.toInt(),
    purpleLight = 0xffeaf1ff.toInt(),
    text = 0xff172033.toInt(),
    sub = 0xff5b6577.toInt(),
    faint = 0xff8792a5.toInt(),
    disabled = 0xffb4bcc8.toInt(),
    pressed = 0x1a172033.toInt(),
    green = 0xff258832.toInt(),
    orange = 0xffc25705.toInt(),
    blue = 0xff336df4.toInt(),
    pink = 0xffd1498b.toInt(),
    pinkBorder = 0xffdee0e3.toInt(),
    red = 0xffe22e28.toInt(),
    teal = 0xff168f9d.toInt(),
    border = 0xffdce3ec.toInt(),
    divider = 0x21172033.toInt(),
    calendarGridDivider = 0x2b172033.toInt(),
    overlay = 0x570f1726.toInt(),
  )
  private val vividPalette = ThemePalette(
    appBg = 0xfff8f6fc.toInt(),
    body = 0xfffffdfe.toInt(),
    card = 0xffffffff.toInt(),
    inputBg = 0xfff2eefc.toInt(),
    tasksBg = 0xfffff0f5.toInt(),
    waveformBg = 0xffefecfa.toInt(),
    loginTop = 0xfffcfaff.toInt(),
    loginBot = 0xfff5f0fc.toInt(),
    logoFrom = 0xff8a72d8.toInt(),
    logoTo = 0xffe17a9e.toInt(),
    primary = 0xff7255c9.toInt(),
    primaryHover = 0xff8467d8.toInt(),
    primaryPressed = 0xff5b40ae.toInt(),
    primaryLight = 0xffeee9fc.toInt(),
    purple = 0xff7255c9.toInt(),
    purpleDark = 0xff4f369d.toInt(),
    gradFrom = 0xff8265d4.toInt(),
    gradTo = 0xffd86f99.toInt(),
    purpleLight = 0xffeee9fc.toInt(),
    text = 0xff211d2d.toInt(),
    sub = 0xff6e687b.toInt(),
    faint = 0xff9992a7.toInt(),
    disabled = 0xffc9c4d1.toInt(),
    pressed = 0x1c7255c9.toInt(),
    green = 0xff52c41a.toInt(),
    orange = 0xffff9500.toInt(),
    blue = 0xff5b8cff.toInt(),
    pink = 0xffff8fab.toInt(),
    pinkBorder = 0xffffb5cc.toInt(),
    red = 0xffff4d4f.toInt(),
    teal = 0xff26c6da.toInt(),
    border = 0xffe4ddec.toInt(),
    divider = 0x2147375c.toInt(),
    calendarGridDivider = 0x2b47375c.toInt(),
    overlay = 0x5c241936.toInt(),
  )
  private val paperPalette = ThemePalette(
    appBg = 0xfff3f0e7.toInt(),
    body = 0xfffcfbf6.toInt(),
    card = 0xfff8f6ef.toInt(),
    inputBg = 0xffefeee6.toInt(),
    tasksBg = 0xfff3f1e8.toInt(),
    waveformBg = 0xffecebe3.toInt(),
    loginTop = 0xfffcfbf6.toInt(),
    loginBot = 0xfff1eee3.toInt(),
    logoFrom = 0xff82943d.toInt(),
    logoTo = 0xff607624.toInt(),
    primary = 0xff637824.toInt(),
    primaryHover = 0xff758a32.toInt(),
    primaryPressed = 0xff4d6018.toInt(),
    primaryLight = 0xffe9edd9.toInt(),
    purple = 0xff637824.toInt(),
    purpleDark = 0xff4d6018.toInt(),
    gradFrom = 0xff82943d.toInt(),
    gradTo = 0xff607624.toInt(),
    purpleLight = 0xffe9edd9.toInt(),
    text = 0xff252621.toInt(),
    sub = 0xff62635d.toInt(),
    faint = 0xff85867e.toInt(),
    disabled = 0xffb4b5ad.toInt(),
    pressed = 0x17252621.toInt(),
    green = 0xff5f7d28.toInt(),
    orange = 0xffb56a22.toInt(),
    blue = 0xff3e718f.toInt(),
    pink = 0xffa95c72.toInt(),
    pinkBorder = 0xffd8c5cb.toInt(),
    red = 0xffc95045.toInt(),
    teal = 0xff3f7c78.toInt(),
    border = 0xffd8d7cd.toInt(),
    divider = 0x21252621.toInt(),
    calendarGridDivider = 0x2b252621.toInt(),
    overlay = 0x6122231e.toInt(),
  )
  private val midnightPalette = ThemePalette(
    appBg = 0xff10141b.toInt(),
    body = 0xff151a22.toInt(),
    card = 0xff1b222d.toInt(),
    inputBg = 0xff202834.toInt(),
    tasksBg = 0xff1d2630.toInt(),
    waveformBg = 0xff18212b.toInt(),
    loginTop = 0xff151a22.toInt(),
    loginBot = 0xff10141b.toInt(),
    logoFrom = 0xff8ab6ff.toInt(),
    logoTo = 0xff5e91eb.toInt(),
    primary = 0xff74a7ff.toInt(),
    primaryHover = 0xff8bb6ff.toInt(),
    primaryPressed = 0xff5a8de7.toInt(),
    primaryLight = 0xff1e3250.toInt(),
    purple = 0xff74a7ff.toInt(),
    purpleDark = 0xff5a8de7.toInt(),
    gradFrom = 0xff74a7ff.toInt(),
    gradTo = 0xff59b9b7.toInt(),
    purpleLight = 0xff1e3250.toInt(),
    text = 0xffeef3fa.toInt(),
    sub = 0xffb0bac8.toInt(),
    faint = 0xff7f8a9a.toInt(),
    disabled = 0xff566170.toInt(),
    pressed = 0x1aeef3fa.toInt(),
    green = 0xff67c587.toInt(),
    orange = 0xffe0a45c.toInt(),
    blue = 0xff75a9ff.toInt(),
    pink = 0xffe588b2.toInt(),
    pinkBorder = 0xff704a5f.toInt(),
    red = 0xffff7770.toInt(),
    teal = 0xff63c7c7.toInt(),
    border = 0xff2c3745.toInt(),
    divider = 0x24dee7f2.toInt(),
    calendarGridDivider = 0x2edee7f2.toInt(),
    overlay = 0x94000000.toInt(),
  )

  fun palette(theme: String): ThemePalette = when (theme) {
    "vivid" -> vividPalette
    "paper" -> paperPalette
    "midnight" -> midnightPalette
    else -> neutralPalette
  }
}
