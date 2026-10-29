package com.laoji.nativeplatform.hardware

import org.json.JSONObject
import java.io.Closeable

internal interface HardwareDuplexTransport : Closeable {
  val transportName: String
  val locator: String
  fun read(timeoutMs: Int = 250): HardwareFrame?
  fun write(message: JSONObject)
  fun isAttached(): Boolean
}

internal open class HardwareRuntimeException(val publicCode: String, message: String, cause: Throwable? = null) :
  IllegalStateException(message, cause)
internal class HardwareTransportException(message: String, cause: Throwable? = null) :
  HardwareRuntimeException("transport_lost", message, cause)
internal class HardwareIncompatibleException(message: String) : HardwareRuntimeException("incompatible", message)
