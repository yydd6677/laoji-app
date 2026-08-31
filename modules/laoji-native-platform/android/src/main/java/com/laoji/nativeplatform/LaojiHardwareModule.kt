package com.laoji.nativeplatform

import com.laoji.nativeplatform.hardware.HardwareLevelEvent
import com.laoji.nativeplatform.hardware.HardwareDeviceRecording
import com.laoji.nativeplatform.hardware.HardwareRuntime
import com.laoji.nativeplatform.hardware.HardwareRuntimeEvents
import com.laoji.nativeplatform.hardware.HardwareRuntimeException
import com.laoji.nativeplatform.hardware.HardwareRuntimeListener
import com.laoji.nativeplatform.hardware.HardwareRuntimeSnapshot
import com.laoji.nativeplatform.hardware.PendingHardwareRecording
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Transport-neutral application boundary for an LJHW/1 recorder.
 *
 * Android USB CDC and BLE live capture share this state owner. Future Wi-Fi
 * bulk transfer stays behind HardwareRuntime and cannot create another meeting
 * ingest pipeline or persistence owner.
 */
class LaojiHardwareModule : Module() {
  private val listener = object : HardwareRuntimeListener {
    override fun onState(snapshot: HardwareRuntimeSnapshot) {
      sendEvent("onHardwareStateChanged", snapshot.toMap())
    }

    override fun onRecordingReady(recording: PendingHardwareRecording) {
      sendEvent("onHardwareRecordingReady", recording.toMap())
    }

    override fun onLevel(level: HardwareLevelEvent) {
      sendEvent("onHardwareLevel", level.toMap())
    }
  }

  override fun definition() = ModuleDefinition {
    Name("LaojiHardware")
    Events(
      "onHardwareStateChanged",
      "onHardwareRecordingReady",
      "onHardwareLevel",
    )

    OnCreate {
      HardwareRuntime.initialize(requireContext())
      HardwareRuntimeEvents.add(listener)
    }

    OnDestroy {
      // Do not tear down an active capture merely because React reloads. The
      // process-wide runtime keeps receiving and finalizing the local file.
      HardwareRuntimeEvents.remove(listener)
    }

    AsyncFunction("getState") Coroutine { ->
      HardwareRuntime.initialize(requireContext())
      HardwareRuntime.getState().toMap()
    }

    AsyncFunction("listDevices") Coroutine { ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.listDevices(requireContext()).map { it.toMap() } }
      }
    }

    AsyncFunction("scanBleDevices") Coroutine { ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.scanBleDevices(requireContext()).map { it.toMap() } }
      }
    }

    AsyncFunction("requestUsbPermission") Coroutine { locator: String ->
      runHardware { HardwareRuntime.requestUsbPermission(requireContext(), locator) }
    }

    AsyncFunction("connectUsb") Coroutine { locator: String ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.connectUsb(requireContext(), locator).toMap() }
      }
    }

    AsyncFunction("connectBle") Coroutine { locator: String ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.connectBle(requireContext(), locator).toMap() }
      }
    }

    AsyncFunction("disconnect") Coroutine { ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.disconnect().toMap() }
      }
    }

    AsyncFunction("startCapture") Coroutine { ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.startCapture().toMap() }
      }
    }

    AsyncFunction("stopCapture") Coroutine { ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.stopCapture()?.toMap() }
      }
    }

    AsyncFunction("pauseCapture") Coroutine { ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.pauseCapture().toMap() }
      }
    }

    AsyncFunction("resumeCapture") Coroutine { ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.resumeCapture().toMap() }
      }
    }

    AsyncFunction("listDeviceRecordings") Coroutine { ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.listDeviceRecordings().map(HardwareDeviceRecording::toMap) }
      }
    }

    AsyncFunction("renameDeviceRecording") Coroutine {
        recordingId: String, generation: String, title: String ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.renameDeviceRecording(recordingId, generation, title).toMap() }
      }
    }

    AsyncFunction("deleteDeviceRecording") Coroutine { recordingId: String, generation: String ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.deleteDeviceRecording(recordingId, generation) }
      }
    }

    AsyncFunction("receiveDeviceRecording") Coroutine {
        recordingId: String, generation: String ->
      withContext(Dispatchers.IO) {
        runHardware {
          val selected = HardwareRuntime.listDeviceRecordings().firstOrNull {
            it.recordingId == recordingId && it.generation == generation
          } ?: throw HardwareRuntimeException("resume_mismatch", "设备录音已发生变化，请刷新后重试。")
          HardwareRuntime.receiveDeviceRecording(selected).toMap()
        }
      }
    }

    AsyncFunction("listPendingRecordings") Coroutine { ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.listPendingRecordings().map { it.toMap() } }
      }
    }

    AsyncFunction("acknowledgeRecording") Coroutine { recordingId: String ->
      withContext(Dispatchers.IO) {
        runHardware { HardwareRuntime.acknowledgeRecording(recordingId) }
      }
    }
  }

  private fun requireContext() = appContext.reactContext?.applicationContext
    ?: throw CodedException("hardware_unavailable", "Android 应用环境尚未就绪。", null)

  private inline fun <T> runHardware(block: () -> T): T = try {
    block()
  } catch (error: HardwareRuntimeException) {
    throw CodedException(error.publicCode, error.message, null)
  }
}
