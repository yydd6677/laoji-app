package com.laoji.nativeplatform.hardware

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

internal data class HardwareBleDevice(
  val locator: String,
  val productName: String,
  val rssi: Int,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "locator" to locator,
    "transport" to "ble",
    "productName" to productName,
    "rssi" to rssi,
    "compatible" to true,
  )
}

internal object BleHardwareDiscovery {
  private val serviceUuid = ParcelUuid(UUID.fromString(BleHardwareProfile.SERVICE_UUID))

  fun hasPermission(context: Context): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
      context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
  } else {
    context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
  }

  @SuppressLint("MissingPermission")
  fun scan(context: Context, durationMs: Long = 3_200L): List<HardwareBleDevice> {
    val application = context.applicationContext
    requirePermission(application)
    val manager = application.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    val adapter = manager.adapter ?: throw HardwareRuntimeException(
      "bluetooth_unavailable",
      "此手机不支持蓝牙连接。",
    )
    if (!adapter.isEnabled) throw HardwareRuntimeException("bluetooth_disabled", "蓝牙尚未开启。")
    val scanner = adapter.bluetoothLeScanner
      ?: throw HardwareRuntimeException("bluetooth_unavailable", "蓝牙暂时不可用。")
    val found = linkedMapOf<String, HardwareBleDevice>()
    val lock = Any()
    var scanFailure: Int? = null
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        val address = result.device.address.uppercase(Locale.ROOT)
        val name = result.scanRecord?.deviceName?.trim().orEmpty()
          .ifBlank { runCatching { result.device.name.orEmpty() }.getOrDefault("") }
          .ifBlank { "外接录音设备" }
        synchronized(lock) {
          val current = found[address]
          if (current == null || result.rssi > current.rssi) {
            found[address] = HardwareBleDevice(
              locator = "ble:$address",
              productName = name,
              rssi = result.rssi,
            )
          }
        }
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        results.forEach { onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, it) }
      }

      override fun onScanFailed(errorCode: Int) {
        scanFailure = errorCode
      }
    }
    val filter = ScanFilter.Builder().setServiceUuid(serviceUuid).build()
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .setReportDelay(0L)
      .build()
    try {
      scanner.startScan(listOf(filter), settings, callback)
      Thread.sleep(durationMs.coerceIn(500L, 10_000L))
    } catch (error: SecurityException) {
      throw HardwareBluetoothPermissionException(error)
    } finally {
      runCatching { scanner.stopScan(callback) }
    }
    scanFailure?.let {
      throw HardwareRuntimeException("bluetooth_scan_failed", "暂时无法搜索附近设备。")
    }
    return synchronized(lock) { found.values.sortedByDescending { it.rssi } }
  }

  @SuppressLint("MissingPermission")
  fun find(context: Context, locator: String): BluetoothDevice {
    requirePermission(context)
    val address = locator.removePrefix("ble:")
    if (address == locator) throw HardwareTransportException("无线设备地址无效。")
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    val adapter = manager.adapter ?: throw HardwareRuntimeException(
      "bluetooth_unavailable",
      "此手机不支持蓝牙连接。",
    )
    return try {
      adapter.getRemoteDevice(address)
    } catch (error: IllegalArgumentException) {
      throw HardwareTransportException("无线设备地址无效。", error)
    }
  }

  fun requirePermission(context: Context) {
    if (!hasPermission(context)) throw HardwareBluetoothPermissionException()
  }
}

/** Android BLE GATT adapter carrying complete LJHW/1 frames over bounded fragments. */
internal class BleHardwareTransport private constructor(
  private val application: Context,
  private val device: BluetoothDevice,
  override val locator: String,
) : HardwareDuplexTransport {
  override val transportName: String = "ble"

  private val closed = AtomicBoolean(false)
  private val connected = AtomicBoolean(false)
  private val serviceDiscoveryStarted = AtomicBoolean(false)
  private val ready = CompletableFuture<Unit>()
  private val incoming = LinkedBlockingQueue<ByteArray>()
  private val writeLock = Any()
  private val stateLock = Any()
  private val fragmenter = BleHardwareFragmenter()
  private val controlReassembler = BleHardwareReassembler()
  private val audioReassembler = BleHardwareReassembler()
  private val notificationQueue = ArrayDeque<BluetoothGattCharacteristic>()

  @Volatile private var gatt: BluetoothGatt? = null
  @Volatile private var controlRx: BluetoothGattCharacteristic? = null
  @Volatile private var maximumPacketBytes = 20
  @Volatile private var pendingWrite: CompletableFuture<Unit>? = null
  @Volatile private var terminalError: HardwareTransportException? = null

  private val callback = object : BluetoothGattCallback() {
    @SuppressLint("MissingPermission")
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      if (closed.get()) return
      if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
        fail(HardwareTransportException("无线录音设备连接已中断。"))
        return
      }
      if (newState != BluetoothProfile.STATE_CONNECTED) return
      connected.set(true)
      runCatching { gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH) }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        runCatching {
          gatt.setPreferredPhy(
            BluetoothDevice.PHY_LE_2M_MASK,
            BluetoothDevice.PHY_LE_2M_MASK,
            BluetoothDevice.PHY_OPTION_NO_PREFERRED,
          )
        }
      }
      if (!gatt.requestMtu(BleHardwareProfile.PREFERRED_MTU)) discoverServices(gatt)
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      if (status == BluetoothGatt.GATT_SUCCESS) {
        maximumPacketBytes = (mtu - 3).coerceIn(20, BleHardwareProfile.MAX_ATTRIBUTE_VALUE_BYTES)
      }
      discoverServices(gatt)
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        fail(HardwareTransportException("无线录音设备服务不可用。"))
        return
      }
      val service = gatt.getService(UUID.fromString(BleHardwareProfile.SERVICE_UUID))
      val rx = service?.getCharacteristic(UUID.fromString(BleHardwareProfile.CONTROL_RX_UUID))
      val controlTx = service?.getCharacteristic(UUID.fromString(BleHardwareProfile.CONTROL_TX_UUID))
      val audioTx = service?.getCharacteristic(UUID.fromString(BleHardwareProfile.AUDIO_TX_UUID))
      if (rx == null || controlTx == null || audioTx == null) {
        fail(HardwareIncompatibleException("无线录音设备缺少必要服务。"))
        return
      }
      controlRx = rx
      synchronized(stateLock) {
        notificationQueue.clear()
        notificationQueue.add(controlTx)
        notificationQueue.add(audioTx)
      }
      enableNextNotification(gatt)
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        fail(HardwareTransportException("无线录音数据订阅失败。"))
        return
      }
      enableNextNotification(gatt)
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      val current = pendingWrite ?: return
      if (status == BluetoothGatt.GATT_SUCCESS) current.complete(Unit)
      else current.completeExceptionally(HardwareTransportException("无线录音设备写入中断。"))
    }

    @Deprecated("Used below Android 13")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      receiveNotification(characteristic.uuid, characteristic.value ?: return)
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      receiveNotification(characteristic.uuid, value)
    }
  }

  override fun read(timeoutMs: Int): ByteArray {
    terminalError?.let { throw it }
    val bytes = incoming.poll(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
    terminalError?.let { throw it }
    return bytes ?: byteArrayOf()
  }

  @SuppressLint("MissingPermission")
  override fun write(bytes: ByteArray) = synchronized(writeLock) {
    if (closed.get() || !connected.get()) throw HardwareTransportException("无线录音设备已断开。")
    val activeGatt = gatt ?: throw HardwareTransportException("无线录音设备尚未就绪。")
    val characteristic = controlRx ?: throw HardwareTransportException("无线录音控制通道尚未就绪。")
    fragmenter.fragment(bytes, maximumPacketBytes).forEach { packet ->
      val completion = CompletableFuture<Unit>()
      pendingWrite = completion
      val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        activeGatt.writeCharacteristic(
          characteristic,
          packet,
          BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
        ) == BluetoothStatusCodes.SUCCESS
      } else {
        @Suppress("DEPRECATION")
        characteristic.value = packet
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        @Suppress("DEPRECATION")
        activeGatt.writeCharacteristic(characteristic)
      }
      if (!started) {
        pendingWrite = null
        throw HardwareTransportException("无线录音设备暂时无法写入。")
      }
      try {
        completion.get(3, TimeUnit.SECONDS)
      } catch (error: TimeoutException) {
        throw HardwareTransportException("无线录音设备写入超时。", error)
      } finally {
        pendingWrite = null
      }
    }
  }

  @SuppressLint("MissingPermission")
  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    connected.set(false)
    pendingWrite?.completeExceptionally(HardwareTransportException("无线录音设备已断开。"))
    pendingWrite = null
    val current = gatt
    gatt = null
    runCatching { current?.disconnect() }
    runCatching { current?.close() }
    incoming.clear()
  }

  override fun isAttached(): Boolean = connected.get() && !closed.get()

  @SuppressLint("MissingPermission")
  private fun discoverServices(gatt: BluetoothGatt) {
    if (!serviceDiscoveryStarted.compareAndSet(false, true)) return
    if (!gatt.discoverServices()) fail(HardwareTransportException("无线录音设备服务发现失败。"))
  }

  @SuppressLint("MissingPermission")
  private fun enableNextNotification(gatt: BluetoothGatt) {
    val next: BluetoothGattCharacteristic? = synchronized(stateLock) {
      if (notificationQueue.isEmpty()) null else notificationQueue.removeFirst()
    }
    if (next == null) {
      ready.complete(Unit)
      return
    }
    if (!gatt.setCharacteristicNotification(next, true)) {
      fail(HardwareTransportException("无线录音数据订阅失败。"))
      return
    }
    val descriptor = next.getDescriptor(UUID.fromString(BleHardwareProfile.CLIENT_CONFIGURATION_UUID))
    if (descriptor == null) {
      fail(HardwareIncompatibleException("无线录音设备缺少通知配置。"))
      return
    }
    val subscriptionValue = if (
      next.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
    ) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
    else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
    val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      gatt.writeDescriptor(descriptor, subscriptionValue) ==
        BluetoothStatusCodes.SUCCESS
    } else {
      @Suppress("DEPRECATION")
      descriptor.value = subscriptionValue
      @Suppress("DEPRECATION")
      gatt.writeDescriptor(descriptor)
    }
    if (!started) fail(HardwareTransportException("无线录音数据订阅失败。"))
  }

  private fun receiveNotification(characteristicUuid: UUID, packet: ByteArray) {
    try {
      val reassembler = when (characteristicUuid.toString().lowercase(Locale.ROOT)) {
        BleHardwareProfile.CONTROL_TX_UUID -> controlReassembler
        BleHardwareProfile.AUDIO_TX_UUID -> audioReassembler
        else -> return
      }
      reassembler.offer(packet)?.let(incoming::offer)
    } catch (error: Throwable) {
      fail(HardwareTransportException("无线录音数据不完整。", error))
    }
  }

  private fun fail(error: HardwareRuntimeException) {
    val public = when (error) {
      is HardwareTransportException -> error
      else -> HardwareTransportException(error.message, error)
    }
    terminalError = public
    connected.set(false)
    ready.completeExceptionally(error)
    pendingWrite?.completeExceptionally(error)
    incoming.offer(byteArrayOf())
  }

  companion object {
    @SuppressLint("MissingPermission")
    fun open(context: Context, device: BluetoothDevice, locator: String): BleHardwareTransport {
      val application = context.applicationContext
      BleHardwareDiscovery.requirePermission(application)
      val transport = BleHardwareTransport(application, device, locator)
      val gatt = device.connectGatt(
        application,
        false,
        transport.callback,
        BluetoothDevice.TRANSPORT_LE,
      ) ?: throw HardwareTransportException("无法连接无线录音设备。")
      transport.gatt = gatt
      try {
        transport.ready.get(15, TimeUnit.SECONDS)
      } catch (error: Throwable) {
        transport.close()
        val cause = error.cause ?: error
        if (cause is HardwareRuntimeException) throw cause
        throw HardwareTransportException("无线录音设备连接超时。", cause)
      }
      return transport
    }
  }
}

internal class HardwareBluetoothPermissionException(cause: Throwable? = null) : HardwareRuntimeException(
  "bluetooth_permission_required",
  "需要允许老记查找并连接附近设备。",
  cause,
)
