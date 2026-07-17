package com.laoji.nativeplatform

// MIN-SPEAKER-001: one native view manager owns manager and enrollment rendering on Android.

import android.content.Context
import android.view.View
import android.view.ViewGroup
import com.laoji.nativeplatform.speaker.SpeakerEnrollmentSurface
import com.laoji.nativeplatform.speaker.SpeakerManagerSurface
import com.laoji.nativeplatform.speaker.SpeakerSnapshotParser
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class LaojiSpeakerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true
  private val onSpeakerAction by EventDispatcher<Map<String, Any?>>()
  private val manager = SpeakerManagerSurface(context, ::emit)
  private val enrollment = SpeakerEnrollmentSurface(context, ::emit)
  private var surface = "manager"
  private var snapshot: Map<String, Any?> = emptyMap()

  init {
    // MIN-SPEAKER-001: Avoid ExpoView clipping native child display lists on Fabric.
    setWillNotDraw(false)
    clipToPadding = false
    addView(manager, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    addView(enrollment, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    render()
  }

  fun setSurface(value: String?) {
    surface = if (value == "enrollment") "enrollment" else "manager"
  }

  fun setSnapshot(value: Map<String, Any?>?) {
    snapshot = value ?: emptyMap()
  }

  fun commitProps() = render()

  private fun render() {
    val managerVisible = surface == "manager"
    manager.visibility = if (managerVisible) View.VISIBLE else View.GONE
    enrollment.visibility = if (managerVisible) View.GONE else View.VISIBLE
    if (managerVisible) manager.render(SpeakerSnapshotParser.manager(snapshot))
    else enrollment.render(SpeakerSnapshotParser.enrollment(snapshot))
  }

  private fun emit(action: Map<String, Any?>) {
    onSpeakerAction(action + mapOf("surface" to surface))
  }
}

class LaojiSpeakerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiSpeaker")
    Constant("snapshotSchemaVersion") { 1 }
    View(LaojiSpeakerView::class) {
      Events("onSpeakerAction")
      Prop("surface") { view: LaojiSpeakerView, value: String? -> view.setSurface(value) }
      Prop("snapshot") { view: LaojiSpeakerView, value: Map<String, Any?>? -> view.setSnapshot(value) }
      OnViewDidUpdateProps<LaojiSpeakerView> { view -> view.commitProps() }
    }
  }
}
