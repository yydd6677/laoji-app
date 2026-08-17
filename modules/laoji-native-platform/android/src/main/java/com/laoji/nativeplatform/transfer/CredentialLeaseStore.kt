package com.laoji.nativeplatform.transfer

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class CredentialLease(
  val scope: String,
  val generation: Long,
  val apiBaseUrl: String,
  val accessToken: String,
  val deviceId: String? = null,
  val deviceEpochId: String? = null,
  val keyVersion: Int? = null,
  val expiresAtMs: Long? = null,
)

/** MIN-UPLOAD-001: WorkManager input never contains a bearer token. */
internal class CredentialLeaseStore(context: Context) {
  private val appContext = context.applicationContext
  private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun put(lease: CredentialLease) {
    require(SCOPE_PATTERN.matches(lease.scope)) { "Invalid credential scope" }
    require(lease.generation >= 0) { "Invalid credential generation" }
    require(lease.accessToken.isNotBlank()) { "Access token is required" }
    val payload = JSONObject()
      .put("scope", lease.scope)
      .put("generation", lease.generation)
      .put("apiBaseUrl", lease.apiBaseUrl)
      .put("accessToken", lease.accessToken)
      .put("deviceId", lease.deviceId)
      .put("deviceEpochId", lease.deviceEpochId)
      .put("keyVersion", lease.keyVersion)
      .put("expiresAtMs", lease.expiresAtMs)
      .toString()
      .toByteArray(Charsets.UTF_8)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val encrypted = cipher.doFinal(payload)
    val value = JSONObject()
      .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
      .toString()
    preferences.edit().putString(key(lease.scope), value).commit()
  }

  fun get(scope: String, generation: Long): CredentialLease? {
    if (!SCOPE_PATTERN.matches(scope) || generation < 0) return null
    val encoded = preferences.getString(key(scope), null) ?: return null
    return runCatching {
      val wrapper = JSONObject(encoded)
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(
        Cipher.DECRYPT_MODE,
        secretKey(),
        GCMParameterSpec(128, Base64.decode(wrapper.getString("iv"), Base64.NO_WRAP))
      )
      val payload = JSONObject(
        String(
          cipher.doFinal(Base64.decode(wrapper.getString("ciphertext"), Base64.NO_WRAP)),
          Charsets.UTF_8
        )
      )
      CredentialLease(
        scope = payload.getString("scope"),
        generation = payload.getLong("generation"),
        apiBaseUrl = payload.getString("apiBaseUrl"),
        accessToken = payload.getString("accessToken"),
        deviceId = payload.optString("deviceId").takeIf { it.isNotBlank() },
        deviceEpochId = payload.optString("deviceEpochId").takeIf { it.isNotBlank() },
        keyVersion = payload.optInt("keyVersion", -1).takeIf { it >= 1 },
        expiresAtMs = payload.optLong("expiresAtMs", -1).takeIf { it >= 0 },
      )
    }.getOrNull()?.takeIf {
      // A token refresh replaces the encrypted lease for the same account.
      // Work that was already queued must be allowed to use that newer lease;
      // otherwise a normal refresh permanently strands a durable upload with
      // `credential-expired`.  A lease older than the work remains invalid,
      // and signing out still clears the scoped lease and cancels scoped work.
      it.scope == scope && it.generation >= generation
    }
  }

  fun clear(scope: String) {
    if (SCOPE_PATTERN.matches(scope)) preferences.edit().remove(key(scope)).commit()
  }

  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build()
    )
    return generator.generateKey()
  }

  private fun key(scope: String) = "lease:$scope"

  private companion object {
    const val PREFERENCES = "laoji-native-credential-leases-v1"
    const val KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "laoji-native-transfer-v1"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    val SCOPE_PATTERN = Regex("^[A-Za-z0-9:_-]{1,120}$")
  }
}
