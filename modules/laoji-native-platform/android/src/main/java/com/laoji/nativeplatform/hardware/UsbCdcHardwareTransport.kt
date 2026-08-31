package com.laoji.nativeplatform.hardware

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import java.io.Closeable
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/** Wire adapter boundary shared by future USB, BLE-control and Wi-Fi transports. */
internal interface HardwareDuplexTransport : Closeable {
  val transportName: String
  val locator: String
  fun read(timeoutMs: Int = 250): ByteArray
  fun write(bytes: ByteArray)
  fun isAttached(): Boolean
}

internal data class HardwareUsbDevice(
  val locator: String,
  val vendorId: Int,
  val productId: Int,
  val deviceName: String,
  val productName: String,
  val manufacturerName: String,
  val serialNumber: String?,
  val hasPermission: Boolean,
  val compatible: Boolean,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "locator" to locator,
    "transport" to "usb",
    "vendorId" to vendorId,
    "productId" to productId,
    "deviceName" to deviceName,
    "productName" to productName,
    "manufacturerName" to manufacturerName,
    "serialNumber" to serialNumber,
    "hasPermission" to hasPermission,
    "compatible" to compatible,
  )
}

internal object UsbHardwareDiscovery {
  private const val USB_CDC_COMMUNICATIONS = 2
  private const val USB_CDC_DATA = 10

  fun list(context: Context): List<HardwareUsbDevice> {
    val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    return manager.deviceList.values
      .map { describe(manager, it) }
      .filter { it.compatible || (it.vendorId == 0x303a && it.productId == 0x1001) }
      .sortedWith(compareBy({ !it.compatible }, { it.productName }, { it.locator }))
  }

  fun find(context: Context, locator: String): UsbDevice? {
    val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    return manager.deviceList.values.firstOrNull { locator(it) == locator }
  }

  fun locator(device: UsbDevice): String = String.format(
    Locale.ROOT,
    "usb:%04x:%04x:%d",
    device.vendorId,
    device.productId,
    device.deviceId,
  )

  fun isCompatible(device: UsbDevice): Boolean {
    var communications = false
    var data = false
    for (index in 0 until device.interfaceCount) {
      when (device.getInterface(index).interfaceClass) {
        USB_CDC_COMMUNICATIONS -> communications = true
        USB_CDC_DATA -> data = true
      }
    }
    return communications && data
  }

  private fun describe(manager: UsbManager, device: UsbDevice): HardwareUsbDevice {
    val permission = manager.hasPermission(device)
    return HardwareUsbDevice(
      locator = locator(device),
      vendorId = device.vendorId,
      productId = device.productId,
      deviceName = device.deviceName.orEmpty(),
      productName = if (permission) device.productName.orEmpty() else "USB 录音设备",
      manufacturerName = if (permission) device.manufacturerName.orEmpty() else "",
      serialNumber = if (permission) runCatching { device.serialNumber }.getOrNull() else null,
      hasPermission = permission,
      compatible = isCompatible(device),
    )
  }
}

internal object UsbPermissionBroker {
  suspend fun request(context: Context, device: UsbDevice): Boolean = withTimeout(30_000) {
    val appContext = context.applicationContext
    val manager = appContext.getSystemService(Context.USB_SERVICE) as UsbManager
    if (manager.hasPermission(device)) return@withTimeout true
    suspendCancellableCoroutine { continuation ->
      val resolved = AtomicBoolean(false)
      val action = "${appContext.packageName}.LAOJI_USB_PERMISSION.${device.deviceId}"
      lateinit var receiver: BroadcastReceiver
      fun finish(granted: Boolean) {
        if (!resolved.compareAndSet(false, true)) return
        runCatching { appContext.unregisterReceiver(receiver) }
        if (continuation.isActive) continuation.resume(granted)
      }
      receiver = object : BroadcastReceiver() {
        override fun onReceive(receivedContext: Context?, intent: Intent?) {
          if (intent?.action != action) return
          val returned = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
          } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
          }
          if (returned?.deviceId != device.deviceId) return
          finish(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
        }
      }
      val filter = IntentFilter(action)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        appContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("DEPRECATION")
        appContext.registerReceiver(receiver, filter)
      }
      val permissionIntent = PendingIntent.getBroadcast(
        appContext,
        device.deviceId,
        Intent(action).setPackage(appContext.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )
      continuation.invokeOnCancellation { finish(false) }
      manager.requestPermission(device, permissionIntent)
    }
  }
}

internal class UsbCdcHardwareTransport private constructor(
  private val appContext: Context,
  override val locator: String,
  private val connection: UsbDeviceConnection,
  private val controlInterface: UsbInterface,
  private val dataInterface: UsbInterface,
  private val inputEndpoint: UsbEndpoint,
  private val outputEndpoint: UsbEndpoint,
) : HardwareDuplexTransport {
  override val transportName: String = "usb"
  private val closed = AtomicBoolean(false)
  private val writeLock = Any()

  override fun read(timeoutMs: Int): ByteArray {
    if (closed.get()) return byteArrayOf()
    val buffer = ByteArray(16_384)
    val count = connection.bulkTransfer(inputEndpoint, buffer, buffer.size, timeoutMs)
    if (count < 0) return byteArrayOf()
    if (count == 0) return byteArrayOf()
    return buffer.copyOf(count)
  }

  override fun write(bytes: ByteArray) = synchronized(writeLock) {
    check(!closed.get()) { "USB hardware transport is closed" }
    var offset = 0
    while (offset < bytes.size) {
      val count = minOf(16_384, bytes.size - offset)
      val written = connection.bulkTransfer(outputEndpoint, bytes, offset, count, 3_000)
      if (written <= 0) throw HardwareTransportException("USB 写入中断")
      offset += written
    }
  }

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    runCatching { connection.releaseInterface(dataInterface) }
    runCatching { connection.releaseInterface(controlInterface) }
    connection.close()
  }

  override fun isAttached(): Boolean = UsbHardwareDiscovery.find(appContext, locator) != null

  companion object {
    private const val USB_RECIPIENT_INTERFACE = 0x01
    private const val SET_LINE_CODING = 0x20
    private const val SET_CONTROL_LINE_STATE = 0x22

    fun open(context: Context, device: UsbDevice): UsbCdcHardwareTransport {
      val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
      if (!manager.hasPermission(device)) throw HardwarePermissionException()
      var control: UsbInterface? = null
      var data: UsbInterface? = null
      for (index in 0 until device.interfaceCount) {
        val candidate = device.getInterface(index)
        if (candidate.interfaceClass == UsbConstants.USB_CLASS_COMM) control = candidate
        if (candidate.interfaceClass == UsbConstants.USB_CLASS_CDC_DATA) data = candidate
      }
      val controlInterface = control ?: throw HardwareIncompatibleException("设备缺少 USB 控制接口")
      val dataInterface = data ?: throw HardwareIncompatibleException("设备缺少 USB 数据接口")
      var input: UsbEndpoint? = null
      var output: UsbEndpoint? = null
      for (index in 0 until dataInterface.endpointCount) {
        val endpoint = dataInterface.getEndpoint(index)
        if (endpoint.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
        if (endpoint.direction == UsbConstants.USB_DIR_IN) input = endpoint
        if (endpoint.direction == UsbConstants.USB_DIR_OUT) output = endpoint
      }
      val inputEndpoint = input ?: throw HardwareIncompatibleException("设备缺少 USB 输入端点")
      val outputEndpoint = output ?: throw HardwareIncompatibleException("设备缺少 USB 输出端点")
      val connection = manager.openDevice(device) ?: throw HardwareTransportException("无法打开 USB 设备")
      try {
        if (!connection.claimInterface(controlInterface, true)) {
          throw HardwareTransportException("无法占用 USB 控制接口")
        }
        if (!connection.claimInterface(dataInterface, true)) {
          throw HardwareTransportException("无法占用 USB 数据接口")
        }
        val lineCoding = byteArrayOf(
          0x00, 0xc2.toByte(), 0x01, 0x00, // 115200 little endian
          0x00, // one stop bit
          0x00, // no parity
          0x08, // eight data bits
        )
        connection.controlTransfer(
          UsbConstants.USB_TYPE_CLASS or USB_RECIPIENT_INTERFACE or UsbConstants.USB_DIR_OUT,
          SET_LINE_CODING,
          0,
          controlInterface.id,
          lineCoding,
          lineCoding.size,
          1_000,
        )
        // Do not assert DTR/RTS: this ESP32-S3 profile may map them to reset.
        connection.controlTransfer(
          UsbConstants.USB_TYPE_CLASS or USB_RECIPIENT_INTERFACE or UsbConstants.USB_DIR_OUT,
          SET_CONTROL_LINE_STATE,
          0,
          controlInterface.id,
          null,
          0,
          1_000,
        )
        return UsbCdcHardwareTransport(
          context.applicationContext,
          UsbHardwareDiscovery.locator(device),
          connection,
          controlInterface,
          dataInterface,
          inputEndpoint,
          outputEndpoint,
        )
      } catch (error: Throwable) {
        runCatching { connection.releaseInterface(dataInterface) }
        runCatching { connection.releaseInterface(controlInterface) }
        connection.close()
        throw error
      }
    }
  }
}

internal open class HardwareRuntimeException(
  val publicCode: String,
  override val message: String,
  cause: Throwable? = null,
) : IllegalStateException(message, cause)

internal class HardwarePermissionException : HardwareRuntimeException(
  "permission_required",
  "需要允许老记访问这个 USB 录音设备。",
)

internal class HardwareIncompatibleException(message: String) : HardwareRuntimeException(
  "incompatible",
  message,
)

internal class HardwareTransportException(message: String, cause: Throwable? = null) :
  HardwareRuntimeException("transport_lost", message, cause)
