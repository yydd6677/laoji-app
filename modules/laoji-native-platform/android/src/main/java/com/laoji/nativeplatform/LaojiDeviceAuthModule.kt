package com.laoji.nativeplatform

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import kotlinx.coroutines.launch

/** Android Keystore boundary for device-v2 identity.
 *
 * JavaScript receives only a DER public key and signatures. Private keys are
 * generated as non-exportable P-256 entries and are never serialized across
 * the bridge.
 */
class LaojiDeviceAuthModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiDeviceAuth")

    AsyncFunction("getOrCreateKey") { keyVersion: Int, promise: Promise ->
      appContext.backgroundCoroutineScope.launch {
        try {
          promise.resolve(keyInfo(keyVersion))
        } catch (error: Throwable) {
          promise.reject("DEVICE_KEY_ERROR", "无法创建设备密钥", error)
        }
      }
    }

    Function("sign") { keyVersion: Int, payloadBase64: String ->
      val alias = alias(keyVersion)
      val entry = keyStore().getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        ?: throw IllegalStateException("设备密钥不存在")
      val signature = Signature.getInstance("SHA256withECDSA")
      signature.initSign(entry.privateKey)
      signature.update(decode(payloadBase64))
      encode(signature.sign())
    }

    AsyncFunction("findProofOfWork") { nonceBase64: String, difficultyBits: Int, promise: Promise ->
      appContext.backgroundCoroutineScope.launch {
        try {
          require(difficultyBits in 1..24) { "工作量难度无效" }
          val nonce = decode(nonceBase64)
          var candidate = 0L
          while (candidate <= Long.MAX_VALUE) {
            val input = ByteArray(nonce.size + 8)
            nonce.copyInto(input)
            var value = candidate
            for (index in 0 until 8) {
              input[input.size - 1 - index] = (value and 0xff).toByte()
              value = value ushr 8
            }
            val digest = MessageDigest.getInstance("SHA-256").digest(input)
            var leading = 0
            for (byte in digest) {
              val unsigned = byte.toInt() and 0xff
              if (unsigned == 0) {
                leading += 8
                continue
              }
              leading += Integer.numberOfLeadingZeros(unsigned) - 24
              break
            }
            if (leading >= difficultyBits) {
              promise.resolve(candidate)
              return@launch
            }
            candidate += 1
          }
          throw IllegalStateException("工作量证明搜索空间耗尽")
        } catch (error: Throwable) {
          promise.reject("DEVICE_POW_ERROR", "无法完成设备注册验证", error)
        }
      }
    }

    Function("deleteKey") { keyVersion: Int ->
      if (keyVersion in 1..100) keyStore().deleteEntry(alias(keyVersion))
    }

    Function("hasKey") { keyVersion: Int ->
      keyVersion in 1..100 && keyStore().containsAlias(alias(keyVersion))
    }

    AsyncFunction("preparePurgeCapability") {
        scopeKind: String,
        deviceEpochId: String,
        bindingId: String?,
        bindingGeneration: String?,
        registrationRequestId: String,
        promise: Promise,
      ->
      appContext.backgroundCoroutineScope.launch {
        try {
          promise.resolve(purgeStore().prepare(
            scopeKind, deviceEpochId, bindingId, bindingGeneration, registrationRequestId,
          ))
        } catch (error: Throwable) {
          promise.reject("PURGE_JOURNAL_ERROR", "无法准备清理凭据", error)
        }
      }
    }

    Function("markPurgeCapabilityArmed") { capabilityId: String ->
      purgeStore().markArmed(capabilityId)
    }

    Function("beginPurgeOnlyErase") {
      purgeStore().beginErase()
    }

    AsyncFunction("resumePurgeOnlyJournal") { apiBase: String, promise: Promise ->
      appContext.backgroundCoroutineScope.launch {
        try {
          promise.resolve(purgeStore().resume(apiBase))
        } catch (error: Throwable) {
          promise.reject("PURGE_JOURNAL_ERROR", "远端清理暂未完成", error)
        }
      }
    }
  }

  private fun purgeStore(): PurgeOnlyJournalStore = PurgeOnlyJournalStore(
    requireNotNull(appContext.reactContext) { "应用上下文不可用" },
  )

  private fun keyInfo(keyVersion: Int): Map<String, Any> {
    if (keyVersion !in 1..100) throw IllegalArgumentException("密钥版本无效")
    val store = keyStore()
    val keyAlias = alias(keyVersion)
    if (!store.containsAlias(keyAlias)) {
      val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEY_STORE)
      generator.initialize(
        KeyGenParameterSpec.Builder(
          keyAlias,
          KeyProperties.PURPOSE_SIGN,
        )
          .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .setUserAuthenticationRequired(false)
          .build(),
      )
      generator.generateKeyPair()
    }
    val certificate = store.getCertificate(keyAlias) ?: throw IllegalStateException("设备公钥缺失")
    return mapOf(
      "keyVersion" to keyVersion,
      "publicKeyDer" to encode(certificate.publicKey.encoded),
    )
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

  private fun alias(keyVersion: Int): String = "$KEY_PREFIX$keyVersion"

  private fun decode(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

  private fun encode(value: ByteArray): String = Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

  companion object {
    private const val ANDROID_KEY_STORE = "AndroidKeyStore"
    private const val KEY_PREFIX = "laoji.device.v2.key."
  }
}
