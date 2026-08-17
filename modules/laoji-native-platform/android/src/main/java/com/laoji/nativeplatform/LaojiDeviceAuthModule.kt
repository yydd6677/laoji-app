package com.laoji.nativeplatform

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature

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
      try {
        promise.resolve(keyInfo(keyVersion))
      } catch (error: Throwable) {
        promise.reject("DEVICE_KEY_ERROR", "无法创建设备密钥", error)
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

    AsyncFunction("rotateKey") { nextKeyVersion: Int, promise: Promise ->
      try {
        if (nextKeyVersion < 1 || nextKeyVersion > 100) throw IllegalArgumentException("密钥版本无效")
        promise.resolve(keyInfo(nextKeyVersion))
      } catch (error: Throwable) {
        promise.reject("DEVICE_KEY_ERROR", "无法轮换设备密钥", error)
      }
    }

    Function("deleteKey") { keyVersion: Int ->
      if (keyVersion in 1..100) keyStore().deleteEntry(alias(keyVersion))
    }

    Function("hasKey") { keyVersion: Int ->
      keyVersion in 1..100 && keyStore().containsAlias(alias(keyVersion))
    }
  }

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
